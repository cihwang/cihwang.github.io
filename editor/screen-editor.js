// 쓰기 화면(`#/new`, `#/edit?repo=…&path=…`): 제목·카테고리·서식·본문, 미리보기, 기기 자동 저장, 임시저장.
// 글 열기(doc-open.js)·미리보기(preview.js)·사진 올리기·출간 설정·충돌·삭제·도움말은 각자 파일에 두고,
// 이 화면은 그들에게 글(doc)과 저장 함수를 건넨다.
import { AUTOSAVE_MS } from './config.js';
import { AuthError, ConflictError } from './github.js';
import { applyFormat } from './format.js';
import { $, local, editHash, failText, mount, addNotice, fetchLive, categoryPills, followRenderedLink, CONFLICT_TEXT } from './ui.js';
import { createPhotoUploader, removeUploadPlaceholders } from './photo-upload.js';
import { createPublishDialog } from './publish-dialog.js';
import { isSaveConflict, resolveSaveConflict } from './conflict-dialog.js';
import { deleteOpenDoc } from './delete-dialog.js';
import { createHelpDialog } from './help-dialog.js';
import { createPreview } from './preview.js';
import { snapshot, loadDoc, chooseDoc } from './doc-open.js';

const PREVIEW_MS = 150;
const LOCAL_LOST = '이 기기에도 저장하지 못했어요. 창을 닫거나 나가면 이 내용이 사라져요.';
const pad = (n) => String(n).padStart(2, '0');
const clockText = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** 화면 키보드가 가린 높이를 `--kb-offset`에 넣는다. 폰에서 서식 줄·아래 막대를 키보드 바로 위에 붙이는 데 쓴다. */
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const style = document.documentElement.style;
  const update = () => style.setProperty('--kb-offset', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    style.removeProperty('--kb-offset');
  };
}

/**
 * 쓰기 화면을 그린다.
 * @param {{ name: 'new'|'edit', params: URLSearchParams, session: { gh: object, store: object, draftsRepo: string },
 *   isCurrent: () => boolean, ask: (message: string, choices: object[]) => Promise<string>, loseLogin: () => void,
 *   reload: (notice?: string) => void, notice?: string|null }} ctx
 *   `params`: 새 글은 `local`(기기 저장 키), 편집은 `repo`·`path`. `isCurrent`는 이 화면이 아직 떠 있는지.
 *   `loseLogin`은 토큰이 풀렸을 때 부르며, 부르기 전에 기기에 저장해 둔다.
 *   `reload`는 지금 주소의 화면을 안내와 함께 새로 그린다(GitHub에서 다시 열기). `notice`는 맨 위에 띄울 안내.
 * @returns {() => void} 화면을 떠날 때 부를 정리 함수(바뀐 내용이 있으면 기기에 저장한다)
 */
export function showEditor({ name, params, session, isCurrent, ask, loseLogin, reload, notice }) {
  const root = mount('editor');
  const el = Object.fromEntries(['title', 'cats', 'toolbar', 'body', 'photo-input', 'preview-title', 'preview-body', 'bar', 'status',
    'exit', 'help', 'menu', 'delete', 'save', 'publish', 'publish-dialog', 'help-dialog'].map((role) => [role, $(root, role)]));
  const { store, gh, draftsRepo } = session;
  let doc = null;
  let key = null;          // 기기 저장 키: draftPath, 없으면 blogPath, 없으면 new:<랜덤>
  let synced = '';         // GitHub에 있는 내용의 snapshot. 지금 내용과 다르면 올리지 않은 변경이 있다.
  let lastSync = null;     // 마지막으로 GitHub 내용과 같았던 시각(ISO). 새 글은 null.
  let localPending = false; // 마지막 기기 저장 뒤 바뀐 것이 있다
  let localFailed = false;  // 마지막 기기 저장이 실패했다. 이때는 "이 기기에 남겨 뒀어요"라고 말하지 않는다.
  let finished = false;     // 출간·삭제·다른 기기 내용 불러오기로 이 글을 끝냈다. 더는 기기에 저장하지 않는다.
  let loginLostShown = false; // 로그인 풀림 + 기기 저장 실패 안내를 이미 띄웠다(거듭 누를 때 같은 안내를 쌓지 않는다)
  let saving = false;
  let autosaveTimer = 0;
  let previewTimer = 0;
  const preview = createPreview({ titleEl: el['preview-title'], bodyEl: el['preview-body'], gh, draftsRepo, getDoc: () => doc, isCurrent });
  const cleanups = [trackKeyboard()];
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  const setStatus = (text) => { el.status.textContent = text; };
  const dirty = () => Boolean(doc) && snapshot(doc.meta, doc.body) !== synced;
  // 폰에서 아래 막대 높이가 상태 글 길이에 따라 바뀌어도 서식 줄이 그 바로 위에 붙게 높이를 넘긴다.
  const barSize = new ResizeObserver(() => root.style.setProperty('--bar-h', `${el.bar.offsetHeight}px`));
  barSize.observe(el.bar);
  cleanups.push(() => barSize.disconnect());
  // 불러오는 동안 친 글은 입력 이벤트를 받기 전이라 불러온 내용에 덮인다. 다 불러올 때까지 막아 둔다.
  el.title.readOnly = true;
  el.body.readOnly = true;
  if (notice) addNotice(root, notice);

  /** 지금 내용을 기기에 저장한다. 실패하면 상태 글에 이유를 쓰고 false. */
  function saveLocal() {
    clearTimeout(autosaveTimer);
    if (!doc || finished) return true;
    const now = new Date().toISOString();
    try {
      local.save(key, { ...doc, savedAt: now, remoteSavedAt: dirty() ? lastSync : now });
      localPending = false;
      localFailed = false;
      return true;
    } catch (e) {
      localFailed = true;
      setStatus(`저장 실패: ${e.message}`);
      return false;
    }
  }

  /** 이 글을 끝냈다: 남은 자동 저장을 멈추고 이후 기기 저장(나갈 때 포함)을 하지 않는다. */
  function stopLocal() {
    finished = true;
    clearTimeout(autosaveTimer);
    localPending = false;
  }

  /** 이 글의 기기 저장본을 지운다. 못 지우면 그 이유 문장, 지웠으면 null. */
  function dropLocal() {
    try {
      local.clear(key);
      return null;
    } catch (e) {
      return e.message;
    }
  }

  /** 주소를 바꾸고(방문 기록은 늘리지 않는다) 그 화면을 안내와 함께 새로 연다. */
  function goTo(hash, text) {
    history.replaceState(null, '', hash);
    reload(text);
  }

  /**
   * 토큰이 풀렸을 때. 기기에 저장했으면 로그인 화면으로 간다. 기기 저장도 실패했으면 쓰던 내용이 이 화면에만 있으니
   * 떠나지 않고 알린 뒤, 사용자가 복사하고 단추를 눌러야 로그인 화면으로 간다.
   */
  function loseLoginSaved() {
    const saved = saveLocal();
    if (!isCurrent()) return;
    if (saved) return loseLogin();
    setStatus('로그인이 풀렸어요. 이 기기에도 저장하지 못했어요.');
    if (loginLostShown) return;
    loginLostShown = true;
    const p = document.createElement('p');
    p.className = 'ed-notice';
    p.append('로그인이 풀렸는데 이 기기에도 저장하지 못해서, 쓰던 내용은 지금 이 화면에만 있어요. 제목과 본문을 복사해 둔 뒤 다시 로그인해 주세요. ');
    const relogin = document.createElement('button');
    relogin.type = 'button';
    relogin.className = 'ed-btn';
    relogin.textContent = '복사했어요, 로그인하기';
    relogin.addEventListener('click', () => { if (isCurrent()) loseLogin(); });
    p.append(relogin);
    $(root, 'notices').append(p);
  }

  function changed() {
    localPending = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (saveLocal() && dirty()) setStatus('이 기기에만 저장됨');
    }, AUTOSAVE_MS);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, PREVIEW_MS);
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    preview.render();
  }

  function format(kind) {
    const r = applyFormat(el.body.value, el.body.selectionStart, el.body.selectionEnd, kind);
    el.body.value = r.text;
    el.body.focus();
    el.body.setSelectionRange(r.start, r.end);
    doc.body = r.text;
    changed();
  }

  /** 기기 키를 바꾼다(새 글이 처음 GitHub에 올라가 경로가 생겼을 때). 옛 키 저장본을 못 지우면 알린다. */
  function moveKey(next) {
    const old = key;
    key = next;
    try {
      local.clear(old);
    } catch (e) {
      addNotice(root, `${e.message} 목록에 같은 글이 "이 기기에만 있음"으로 한 번 더 보일 수 있어요.`);
    }
    if (isCurrent()) history.replaceState(null, '', editHash('drafts', next));
  }

  async function saveRemote() {
    if (!doc || saving || finished) return;
    // 이미 초안 저장소와 같은 내용이면 빈 커밋을 만들지 않는다.
    if (doc.draftPath && !dirty()) return setStatus('바뀐 내용이 없어요.');
    saving = true;
    // GitHub가 실패해도 쓰던 내용이 남도록 기기에 먼저 저장한다.
    saveLocal();
    setStatus(localFailed ? '저장하는 중… (이 기기에는 저장하지 못했어요)' : '저장하는 중…');
    const sent = { ...doc, meta: { ...doc.meta } };
    let conflict = false;
    try {
      const saved = await store.saveDraft(sent);
      // 기다리는 동안 더 쓴 내용은 doc에 그대로 두고, 경로·sha만 받아 온다.
      Object.assign(doc, { draftPath: saved.draftPath, draftSha: saved.draftSha });
      doc.meta.draft = saved.meta.draft;
      synced = snapshot(saved.meta, sent.body);
      lastSync = new Date().toISOString();
      if (key !== saved.draftPath) moveKey(saved.draftPath);
      saveLocal();
      const later = localFailed ? ' (그 뒤 고친 내용은 아직 어디에도 저장되지 않았어요)' : ' (그 뒤 고친 내용은 이 기기에만 있어요)';
      setStatus(`저장됨 · ${clockText(new Date())}${dirty() ? later : ''}`);
    } catch (e) {
      if (e instanceof AuthError) return loseLoginSaved();
      conflict = isSaveConflict(e, sent);
      // 기기 저장도 실패했으면 충돌 안내의 "이 기기 내용은 남겨 뒀어요"는 거짓이 된다.
      let reason = failText(e);
      if (conflict) reason = localFailed ? '다른 기기에서 먼저 저장했어요. 덮어쓰지 않았어요.' : CONFLICT_TEXT;
      else if (e instanceof ConflictError) reason = '같은 날짜·주소의 초안이 이미 있어요. 덮어쓰지 않았어요. 제목을 바꿔 다시 저장해 주세요.';
      setStatus(`저장 실패: ${reason}${localFailed ? ` ${LOCAL_LOST}` : ''}`);
    } finally {
      saving = false;
    }
    if (conflict && isCurrent()) {
      await resolveSaveConflict({
        ask, getDoc: () => doc, key: () => key, gh, draftsRepo, localFailed: () => localFailed, setStatus, stopLocal, goTo,
        retrySave: saveRemote, loseLogin: loseLoginSaved, isCurrent,
      });
    }
  }

  /** 출간 설정 창에서 고른 값을 머리말과 쓰기 화면 알약에 넣는다. */
  function applyMeta(patch, categories) {
    Object.assign(doc.meta, patch);
    renderCats(categories);
    changed();
  }

  /** 출간 커밋 뒤 초안 정리만 실패했을 때: 새로 읽은 공개본 경로·sha를 받아 이 글을 "공개된 글 고치는 중"으로 둔다. */
  function adoptShas(patch) {
    Object.assign(doc, patch);
    el.publish.textContent = '수정하기';
    saveLocal();
  }

  function selectTab(pane, focus) {
    root.dataset.pane = pane;
    for (const tab of root.querySelectorAll('[role="tab"]')) {
      const on = tab.dataset.tab === pane;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
  }

  function renderCats(categories) {
    const add = document.createElement('a');
    add.className = 'ed-pill-add';
    add.href = '#/categories';
    add.textContent = '+';
    add.setAttribute('aria-label', '카테고리 관리');
    el.cats.replaceChildren(...categoryPills('category', categories, doc.meta.category), add);
  }

  function wire() {
    const uploader = createPhotoUploader({
      textarea: el.body,
      input: el['photo-input'],
      listen,
      upload: (blob, fileName, rand) => store.uploadMedia(blob, fileName, rand),
      onBodyChange: () => { doc.body = el.body.value; changed(); },
      // 방금 올린 사진은 초안 저장소에서 다시 받지 않고 가진 것으로 미리 보인다.
      onUploaded: preview.remember,
      status: setStatus,
      report: (text) => addNotice(root, text),
      onAuthLost: loseLoginSaved,
      isCurrent,
    });
    const publishDialog = createPublishDialog({
      dialog: el['publish-dialog'], session, getDoc: () => doc, applyMeta, adoptShas, uploading: uploader.pending,
      saveLocal, stopLocal, dropLocal, goTo, loseLogin: loseLoginSaved, isCurrent, opener: el.publish,
    });
    const helpDialog = createHelpDialog({ dialog: el['help-dialog'], gh, loseLogin: loseLoginSaved, isCurrent });
    listen(el.title, 'input', () => { doc.meta.title = el.title.value; changed(); });
    // 제목은 한 줄이다. Enter는 줄을 바꾸지 않고 본문으로 넘어간다.
    listen(el.title, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.body.focus(); }
    });
    listen(el.cats, 'change', (e) => { doc.meta.category = e.target.value; changed(); });
    listen(el.body, 'input', () => { doc.body = el.body.value; changed(); });
    // 단추를 눌러도 본문 칸의 초점을 뺏지 않는다. 폰에서 키보드가 내려갔다 올라오는 것을 막는다.
    listen(el.toolbar, 'mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    listen(el.toolbar, 'click', (e) => {
      const button = e.target.closest('button');
      if (button?.dataset.format) format(button.dataset.format);
      else if (button?.dataset.action === 'photo') uploader.pick();
    });
    listen(el.save, 'click', saveRemote);
    listen(el.publish, 'click', () => {
      if (uploader.pending()) return setStatus('사진을 올리는 중이에요. 다 올라간 뒤 출간해 주세요.');
      publishDialog.open();
    });
    listen(el.help, 'click', helpDialog.open);
    listen(el.delete, 'click', () => {
      el.menu.open = false;
      deleteOpenDoc({ ask, getDoc: () => doc, key: () => key, store, saveLocal, stopLocal, dropLocal, goTo, setStatus, loseLogin: loseLoginSaved, isCurrent });
    });
    // 펼친 메뉴는 바깥을 누르거나 Esc로 닫는다(details는 저절로 닫히지 않는다).
    listen(document, 'click', (e) => {
      if (el.menu.open && !el.menu.contains(e.target)) el.menu.open = false;
    });
    listen(el.menu, 'keydown', (e) => {
      if (e.key !== 'Escape' || !el.menu.open) return;
      el.menu.open = false;
      el.menu.querySelector('summary').focus();
    });
    listen(el.exit, 'click', async () => {
      if (dirty()) {
        // 묻는 문장이 맞도록 먼저 기기에 저장해 본다.
        if (localPending) saveLocal();
        const question = localFailed
          ? `GitHub에 올리지 않은 변경이 있어요. ${LOCAL_LOST} 나갈까요?`
          : 'GitHub에 올리지 않은 변경이 있어요. 이 기기에는 남겨 둘게요. 나갈까요?';
        const choice = await ask(question, [
          { label: '계속 쓰기', value: '' },
          { label: '나가기', value: 'leave', primary: true },
        ]);
        if (choice !== 'leave' || !isCurrent()) return;
      }
      location.hash = '#/';
    });
    for (const tab of root.querySelectorAll('[role="tab"]')) {
      listen(tab, 'click', () => selectTab(tab.dataset.tab));
      listen(tab, 'keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') selectTab(tab.dataset.tab === 'write' ? 'preview' : 'write', true);
      });
    }
    // 미리보기 안 링크: 각주·제목(#…)은 미리보기 안에서 움직이고, 바깥 링크는 새 탭으로. 이 페이지 주소(#/…)는 바꾸지 않는다.
    listen(el['preview-body'], 'click', (e) => followRenderedLink(el['preview-body'], e));
    listen(window, 'beforeunload', (e) => {
      if (finished) return;
      if (localPending) saveLocal();
      // 올리는 중인 사진은 떠나면 본문에 들어가지 못한다.
      if (!dirty() && !uploader.pending()) return;
      e.preventDefault();
      // Safari 등은 아직 returnValue를 봐야 묻는다.
      e.returnValue = '';
    });
    // 폰은 탭을 닫을 때 beforeunload가 안 올 수 있어, 화면이 가려지는 순간에도 기기에 저장한다.
    listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden' && localPending) saveLocal();
    });
  }

  // Ctrl/Cmd+S는 불러오는 중에도 브라우저 "페이지 저장"이 뜨지 않게 바로 막는다.
  // 한글 입력 중에는 e.key가 'ㄴ'·'ㅠ'·'ㅑ'가 되므로 글쇠 자리(e.code)로 본다. 조합 중에는 동작만 건너뛴다.
  listen(document, 'keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.code === 'KeyS') {
      e.preventDefault();
      // 창이 떠 있는 동안(출간 중·충돌 고르기 등)에는 저장하지 않는다. 출간 중에 초안 sha가 바뀌면 초안 정리가 실패한다.
      if (!e.isComposing && !document.querySelector('dialog[open]')) saveRemote();
    } else if ((e.code === 'KeyB' || e.code === 'KeyI') && !e.isComposing && doc && document.activeElement === el.body) {
      e.preventDefault();
      format(e.code === 'KeyB' ? 'bold' : 'italic');
    }
  });

  function showLoadError(message) {
    $(mount('load-error'), 'message').textContent = `글을 불러오지 못했어요. ${message}`;
  }

  (async () => {
    setStatus('불러오는 중…');
    // 카테고리는 다른 기기에서 바뀌었을 수 있어 화면을 열 때마다 site.json을 새로 읽는다.
    const [site, live, opened] = await Promise.allSettled([store.getSite(), fetchLive(), loadDoc({ name, params, store })]);
    if (!isCurrent()) return;
    if ([site, live, opened].some((r) => r.status === 'rejected' && r.reason instanceof AuthError)) return loseLogin();
    if (opened.status === 'rejected') return showLoadError(opened.reason.message);
    const { remote, saved, blank } = opened.value;
    key = opened.value.key;
    const picked = remote ? await chooseDoc(remote, saved, ask) : { doc: saved ?? blank, dropLocal: false };
    if (!isCurrent()) return;
    doc = picked.doc;
    const base = remote ?? blank;
    synced = snapshot(base.meta, base.body);
    lastSync = remote ? new Date().toISOString() : null;
    if (picked.dropLocal) saveLocal();
    // 올리던 중에 창을 닫았으면 끝나지 못한 자리표시 줄이 기기 저장본에 남는다. 그대로 두면 깨진 그림 줄이 된다.
    const stale = removeUploadPlaceholders(doc.body);
    if (stale.count) {
      doc.body = stale.body;
      saveLocal();
      addNotice(root, `끝나지 못한 사진 자리 ${stale.count}개를 본문에서 지웠어요. 그 사진은 다시 올려 주세요.`);
    }
    if (site.status === 'rejected') addNotice(root, `카테고리 목록을 불러오지 못했어요. 임시저장 전에 새로고침해 주세요. (${site.reason.message})`);
    // 라이브 글 목록은 출간 검사에 쓴다. 못 받아도 쓰기는 계속할 수 있다.
    if (live.status === 'rejected') addNotice(root, `${live.reason.message} 쓰기와 임시저장은 그대로 할 수 있어요.`);
    renderCats(site.value?.categories ?? []);
    el.title.value = doc.meta.title ?? '';
    el.body.value = doc.body;
    el.publish.textContent = doc.blogPath ? '수정하기' : '출간하기';
    renderPreview();
    setStatus(dirty() ? '이 기기에만 저장됨' : '');
    el.title.readOnly = false;
    el.body.readOnly = false;
    wire();
  })();

  return () => {
    if (localPending) saveLocal();
    clearTimeout(autosaveTimer);
    clearTimeout(previewTimer);
    for (const off of cleanups) off();
    preview.revokeAll();
  };
}
