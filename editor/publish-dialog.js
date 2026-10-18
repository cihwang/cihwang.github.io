// 출간 설정 창: 카테고리·날짜·주소를 고르고, 출간한 뒤 사이트에 반영될 때까지 기다려 그 글로 데려간다.
import { renderMarkdown, slugFromPath } from '../markdown.js';
import { BLOG_REPO } from './config.js';
import { AuthError, ConflictError, GitHubError } from './github.js';
import { waitForDeploy } from './deploy.js';
import { parsePost, serializePost, slugFromTitle, postPath } from './post.js';
import { checkPublish } from './publish-check.js';
import { $, editHash, fetchLive, categoryPills, postUrl, shownUrl } from './ui.js';
import { isBlogConflict } from './conflict-dialog.js';

const BUSY_TEXT = '올리는 중… 사이트에 보이기까지 보통 30초~1분 걸려요.';
const NOT_YET_TEXT = '아직 반영 중이에요. 잠시 후 사이트에서 확인해 주세요.';
const BUILD_HINT = '시간이 더 지나도 안 보이면 빌드가 실패했을 수 있어요.';
const ACTIONS_URL = `https://github.com/${BLOG_REPO}/actions`;
// 공개본 자체가 바뀐 충돌은 resolveBlogConflict 창이 맡는다. 여기 오는 ConflictError는 옮길 자리에 다른 글이 있는 경우다.
const PUBLISH_CONFLICT = '같은 날짜·주소(slug)에 다른 글이 이미 있어요. 덮어쓰지 않았어요. 날짜나 주소를 바꿔 주세요.';
const ROLES = ['publish-form', 'publish-notes', 'publish-fields', 'publish-cats', 'publish-url', 'publish-msg',
  'publish-cancel', 'publish-confirm', 'publish-to-list', 'error-category', 'error-date', 'error-slug'];
const pad = (n) => String(n).padStart(2, '0');
const withoutDraft = ({ draft, ...rest }) => rest;

function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 블로그에 올라가는 파일 텍스트(store.publish가 쓰는 것과 같다). */
const publishedText = (doc) => serializePost(withoutDraft(doc.meta), doc.body);

/**
 * 쓰기 화면에 출간 설정 창을 붙인다. 출간·수정은 `store.publish` 한 번이고, 성공하면 기기 저장본을 지운 뒤
 * `waitForDeploy`로 사이트 반영을 기다린다. 반영되면 그 글 주소로 옮기고, 시간이 지나면 링크와 함께 안내한다.
 * @param {{ dialog: HTMLDialogElement, session: { gh: object, store: object, draftsRepo: string }, getDoc: () => object,
 *   applyMeta: (patch: { category: string, date: string, slug: string }, categories: string[]) => void,
 *   adoptShas: (patch: { blogPath: string, blogSha: string }) => void,
 *   uploading: () => number, saveLocal: () => boolean, stopLocal: () => void, dropLocal: () => string|null,
 *   goTo: (hash: string, notice: string) => void, loseLogin: () => void, isCurrent: () => boolean, opener: HTMLElement,
 *   resolveBlogConflict: () => Promise<void> }} ctx
 *   `applyMeta`는 고른 값을 글 머리말과 쓰기 화면 알약에 넣는다. `adoptShas`는 GitHub에서 새로 읽은 공개본 경로·sha를 글에 넣는다.
 *   `resolveBlogConflict`는 고치기 시작한 뒤 공개본이 바뀌어 출간이 막혔을 때 이 창을 닫고 부른다(어느 쪽을 기준으로 할지 묻는다).
 *   `uploading`은 올리는 중인 사진 수.
 *   `stopLocal`은 이후 기기 저장을 멈추고, `dropLocal`은 기기 저장본을 지운다(못 지우면 그 이유 문장).
 *   `goTo`는 주소를 바꿔 그 화면을 안내와 함께 새로 연다. `opener`는 창을 닫으면 초점을 돌려줄 단추.
 * @returns {{ open: () => Promise<void> }} `open`은 창을 띄우고 카테고리·사이트 글 목록을 새로 받는다.
 */
export function createPublishDialog(ctx) {
  const { dialog, getDoc, isCurrent } = ctx;
  const { store, gh, draftsRepo } = ctx.session;
  const el = Object.fromEntries(ROLES.map((role) => [role, $(dialog, role)]));
  const { date: dateInput, slug: slugInput } = el['publish-form'].elements;
  let phase = 'closed'; // 'edit' 고르는 중 · 'busy' 올리는 중 · 'done' 끝(시간 초과 등 안내)
  let openId = 0;
  let loading = false;
  let categories = null; // 받지 못했으면 null
  let livePosts = null;
  let notesText = '';

  const chosen = () => ({
    category: el['publish-cats'].querySelector('input:checked')?.value ?? '',
    date: dateInput.value,
    slug: slugInput.value.trim(),
  });

  function note(text, kind) {
    const p = document.createElement('p');
    p.className = kind === 'warning' ? 'ed-notice is-warning' : 'ed-notice';
    p.textContent = kind === 'warning' ? `${text} (출간은 할 수 있어요)` : text;
    return p;
  }

  function setMsg(text, focus = false) {
    el['publish-msg'].textContent = text;
    if (focus) el['publish-msg'].focus();
  }

  /** 고른 값으로 검사해 오류는 칸 옆에, 칸이 없는 오류와 경고는 위에 보이고, 확인 단추를 켜고 끈다. */
  function render() {
    const doc = getDoc();
    const pick = chosen();
    el['publish-url'].textContent = `주소: ${shownUrl(pick)}`;
    const result = loading ? null : checkPublish({ ...doc.meta, ...pick }, doc.body, {
      categories, livePosts, ownPath: doc.blogPath, uploading: ctx.uploading(),
    });
    const notes = result ? [...result.top.map((t) => [t, 'error']), ...result.warnings.map((w) => [w, 'warning'])] : [];
    // 같은 내용을 다시 넣으면 화면 낭독기가 글자를 칠 때마다 다시 읽는다.
    const text = notes.map(([t]) => t).join('\n');
    if (text !== notesText) {
      notesText = text;
      el['publish-notes'].replaceChildren(...notes.map(([t, kind]) => note(t, kind)));
    }
    for (const [field, input] of [['category', null], ['date', dateInput], ['slug', slugInput]]) {
      const errors = result?.fields[field] ?? [];
      el[`error-${field}`].textContent = errors.join(' · ');
      input?.setAttribute('aria-invalid', String(errors.length > 0));
    }
    el['publish-confirm'].disabled = phase !== 'edit' || !result?.ok;
  }

  function setBusy(busy) {
    phase = busy ? 'busy' : 'edit';
    el['publish-fields'].disabled = busy;
    el['publish-cancel'].disabled = busy;
    render();
  }

  function showActions(done) {
    el['publish-cancel'].hidden = done;
    el['publish-confirm'].hidden = done;
    el['publish-to-list'].hidden = !done;
  }

  async function open() {
    if (dialog.open) return;
    const doc = getDoc();
    const id = ++openId;
    phase = 'edit';
    loading = true;
    // 공개된 글의 날짜를 오늘로 바꾸면 파일이 옮겨지고 순서가 바뀐다. 공개된 글은 원래 날짜, 새 글은 오늘이 기본이다.
    dateInput.value = doc.blogPath && doc.meta.date ? doc.meta.date : todayText();
    slugInput.value = doc.meta.slug || (doc.blogPath ? slugFromPath(doc.blogPath) : slugFromTitle(doc.meta.title ?? ''));
    el['publish-cats'].replaceChildren(...categoryPills('publish-category', categories ?? [], doc.meta.category));
    el['publish-confirm'].textContent = doc.blogPath ? '수정하기' : '출간하기';
    el['publish-fields'].disabled = false;
    el['publish-cancel'].disabled = false;
    showActions(false);
    setMsg('카테고리와 사이트 글 목록을 확인하는 중…');
    render();
    dialog.showModal();
    // 다른 기기에서 카테고리나 공개 글이 바뀌었을 수 있어 창을 열 때마다 새로 받는다.
    const [site, live] = await Promise.allSettled([store.getSite(), fetchLive()]);
    if (id !== openId || !isCurrent() || phase !== 'edit') return;
    if (site.status === 'rejected' && site.reason instanceof AuthError) {
      phase = 'closed';
      dialog.close();
      return ctx.loseLogin();
    }
    categories = site.status === 'fulfilled' ? site.value.categories : null;
    livePosts = live.status === 'fulfilled' ? live.value : null;
    el['publish-cats'].replaceChildren(...categoryPills('publish-category', categories ?? [], chosen().category || doc.meta.category));
    loading = false;
    setMsg('');
    render();
  }

  /**
   * 오류가 난 출간이 블로그에는 이미 올라갔는지(커밋 뒤 초안 삭제만 실패) GitHub에서 새로 읽어 본다.
   * @returns {Promise<{ path: string|null, blogSha: string|null, draftSha: string|null }>}
   *   `path`·`blogSha`: 보낸 내용과 같은 블로그 글(없으면 null). `draftSha`: 초안 저장소에 남은 초안의 sha(없으면 null).
   */
  async function publishedState(sent) {
    const text = publishedText(sent);
    const paths = [...new Set([sent.blogPath, postPath(sent.meta.date, sent.meta.slug)].filter(Boolean))];
    const [draft, ...files] = await Promise.all([gh.getFile(draftsRepo, sent.draftPath), ...paths.map((p) => gh.getFile(BLOG_REPO, p))]);
    const i = files.findIndex((f) => f?.text === text);
    return { path: i === -1 ? null : paths[i], blogSha: files[i]?.sha ?? null, draftSha: draft?.sha ?? null };
  }

  /** 끝 안내: `text`, 글 링크, `extra`. `notYet`이면 빌드 실패일 수 있다며 GitHub Actions 링크(새 탭)를 덧붙인다. */
  function showDone(sent, text, extra, notYet) {
    phase = 'done';
    const link = document.createElement('a');
    link.href = postUrl(sent.meta);
    link.textContent = shownUrl(sent.meta);
    const hint = [];
    if (notYet) {
      const actions = document.createElement('a');
      actions.href = ACTIONS_URL;
      actions.target = '_blank';
      actions.rel = 'noopener';
      actions.textContent = 'GitHub Actions';
      hint.push(` ${BUILD_HINT} `, actions, '에서 확인해 주세요.');
    }
    el['publish-msg'].replaceChildren(`${text} `, link, extra ? ` ${extra}` : '', ...hint);
    showActions(true);
    el['publish-to-list'].focus();
  }

  /** 블로그에 올라간 뒤: 기기 저장본을 지우고 사이트 반영을 기다려 그 글로 옮긴다. */
  async function finishPublished(path, sent) {
    // 그 사이 다른 화면으로 갔어도 출간은 끝났으니 기기 저장본은 지운다.
    ctx.stopLocal();
    const notCleared = ctx.dropLocal();
    if (!isCurrent()) return;
    setMsg(BUSY_TEXT);
    // build.js가 posts.json에 넣는 값과 같게: 올린 파일을 다시 읽은 머리말, slug가 없으면 경로에서, 날짜가 없으면 ''.
    const { meta, body } = parsePost(publishedText(sent));
    const deployed = await waitForDeploy({
      path, html: renderMarkdown(body), cat: meta.category, title: meta.title, slug: meta.slug || slugFromPath(path), date: meta.date || '',
    });
    if (!isCurrent()) return;
    // 기기 저장본을 못 지웠으면 그 안내를 볼 수 있게 옮기지 않는다.
    if (deployed && !notCleared) {
      location.href = postUrl(sent.meta);
      return;
    }
    showDone(sent, deployed ? '사이트에 올라갔어요.' : NOT_YET_TEXT, notCleared, !deployed);
  }

  async function publishFailed(err, sent) {
    if (!isCurrent()) return;
    if (err instanceof AuthError) {
      phase = 'closed';
      dialog.close();
      return ctx.loseLogin();
    }
    if (isBlogConflict(err, sent)) {
      // 고치기 시작한 뒤 공개본이 에디터 밖에서 바뀌었다. 다시 열어도 같은 기준(base_sha)으로 또 부딪히므로,
      // 이 창을 닫고 어느 쪽을 기준으로 할지 묻는다. 고른 뒤 수정하기를 다시 눌러야만 블로그에 쓴다.
      phase = 'closed';
      dialog.close();
      return ctx.resolveBlogConflict();
    }
    // 초안이 있는 글의 GitHub 오류는 블로그 커밋 뒤 초안 삭제에서 났을 수 있다. 그대로 다시 누르면 오래된 sha로 부딪히므로 확인한다.
    if (err instanceof GitHubError && !(err instanceof ConflictError) && sent.draftPath) {
      let state = null;
      try {
        state = await publishedState(sent);
      } catch {
        // 확인하지 못했으면 다 됐는지 모르는 상태다. 아래에서 GitHub에서 다시 연다.
      }
      if (!isCurrent()) return;
      if (state?.path && !state.draftSha) return finishPublished(state.path, sent);
      if (state?.path && state.draftSha === sent.draftSha) {
        // 남은 초안은 내가 열었던 그대로다. 방금 읽은 공개본 경로·sha만 받아 두면, 다시 눌렀을 때 커밋 없이 초안만 지운다.
        ctx.adoptShas({ blogPath: state.path, blogSha: state.blogSha });
        setBusy(false);
        el['publish-confirm'].textContent = '수정하기';
        setMsg(`출간은 됐어요(사이트 반영까지 30초~1분). 그런데 초안 저장소의 초안을 지우지 못했어요. 수정하기를 한 번 더 누르면 초안 정리를 마쳐요. (${err.message})`, true);
        return;
      }
      if (!state || state.path) {
        // 다 됐는지 모르거나, 그 사이 다른 기기가 초안을 저장했다. GitHub에서 다시 연다. 지금 내용을 기기에 남겨 두면
        // 다시 열 때 GitHub 내용과 다르면 어느 쪽을 쓸지 묻는다.
        const notice = state
          ? `출간은 됐어요(사이트 반영까지 30초~1분). 그런데 그 사이 다른 기기에서 초안을 저장해서 초안은 지우지 않고 GitHub에서 다시 불러왔어요. (${err.message})`
          : `출간이 됐는지 확인하지 못해 GitHub에서 다시 불러왔어요. 사이트에서 글을 확인한 뒤 필요하면 다시 출간해 주세요. (${err.message})`;
        phase = 'closed';
        ctx.saveLocal();
        return ctx.goTo(editHash('drafts', sent.draftPath), notice);
      }
    }
    setBusy(false);
    setMsg(`출간하지 못했어요. ${err instanceof ConflictError ? PUBLISH_CONFLICT : err.message}`, true);
  }

  el['publish-form'].addEventListener('input', render);
  el['publish-form'].addEventListener('change', render);
  el['publish-form'].addEventListener('submit', async (e) => {
    e.preventDefault();
    if (phase !== 'edit' || loading) return;
    render();
    if (el['publish-confirm'].disabled) return;
    ctx.applyMeta(chosen(), categories);
    const doc = getDoc();
    const sent = { ...doc, meta: { ...doc.meta } };
    setBusy(true);
    setMsg(BUSY_TEXT, true);
    let result;
    try {
      result = await store.publish(sent, livePosts);
    } catch (err) {
      return publishFailed(err, sent);
    }
    return finishPublished(result.path, sent);
  });
  el['publish-cancel'].addEventListener('click', () => dialog.close());
  el['publish-to-list'].addEventListener('click', () => { location.hash = '#/'; });
  // 올리는 중에는 Esc로 닫지 않는다. Chrome은 Esc를 거듭 누르면 막아도 닫으므로 close에서 다시 띄운다.
  dialog.addEventListener('cancel', (e) => {
    if (phase === 'busy') e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (phase === 'busy' && dialog.isConnected) return void dialog.showModal();
    if (phase === 'done') return void (location.hash = '#/');
    phase = 'closed';
    ctx.opener.focus();
  });

  return { open };
}
