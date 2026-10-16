// 카테고리 관리 화면(`#/categories`): 사이트 휠 순서의 이름과 글 수, 새 카테고리 만들기, 이름 바꾸기.
import { AuthError, ConflictError } from './github.js';
import { validateCategoryName } from './post.js';
import { $, mount, addNotice, fetchLive } from './ui.js';

const CONFLICT_RELOAD = '다른 기기에서 카테고리를 먼저 바꿨어요. 이 화면의 목록을 다시 불러왔으니 확인하고 다시 해 주세요.';

/**
 * 카테고리 관리 화면을 그린다.
 * @param {{ session: { store: object }, isCurrent: () => boolean, loseLogin: (before?: string) => void, notice?: string|null }} ctx
 *   `isCurrent`는 이 화면이 아직 떠 있는지, `notice`는 맨 위에 띄울 안내.
 * @returns {() => void} 화면을 떠날 때 부를 정리 함수
 */
export function showCategories({ session, isCurrent, loseLogin, notice }) {
  const root = mount('categories');
  const { store } = session;
  const status = $(root, 'status');
  const listEl = $(root, 'cat-list');
  const addForm = $(root, 'add-form');
  const addName = $(root, 'add-name');
  const addError = $(root, 'add-error');
  const addSubmit = $(root, 'add-submit');
  const dialog = $(root, 'rename-dialog');
  const renameName = $(root, 'rename-name');
  const renameError = $(root, 'rename-error');
  const renameInfo = $(root, 'rename-info');
  const renameSubmit = $(root, 'rename-submit');
  const renameCancel = $(root, 'rename-cancel');

  let categories = [];
  /** 라이브 글 수 `{ [카테고리]: n }`. 사이트 글 목록을 못 받았으면 null(수를 모른다). */
  let counts = null;
  let busy = false;
  let renaming = null;
  if (notice) addNotice(root, notice);

  const countOf = (name) => (counts ? counts[name] ?? 0 : null);

  function setBusy(on) {
    busy = on;
    for (const b of listEl.querySelectorAll('button')) b.disabled = on;
    addName.disabled = on;
    renameName.disabled = on;
    renameCancel.disabled = on;
    refreshAdd();
    refreshRename();
  }

  function renderList() {
    listEl.replaceChildren(...categories.map((name) => {
      const row = document.createElement('li');
      row.className = 'ed-draft';
      const main = document.createElement('div');
      main.className = 'ed-draft-main';
      const title = document.createElement('span');
      title.className = 'ed-draft-title';
      title.textContent = name;
      const meta = document.createElement('span');
      meta.className = 'ed-draft-meta';
      const n = countOf(name);
      meta.textContent = n === null ? '글 수를 알 수 없어요' : `글 ${n}편`;
      main.append(title, meta);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'ed-btn';
      rename.textContent = '이름 바꾸기';
      rename.setAttribute('aria-label', `${name} 이름 바꾸기`);
      rename.disabled = busy;
      rename.addEventListener('click', () => openRename(name, rename));
      row.append(main, rename);
      return row;
    }));
  }

  /** 지금 site.json을 새로 읽어 목록을 다시 그린다. 이미 만든 알약도 쓰기 화면이 열릴 때 새로 읽어 바로 맞는다. */
  async function reloadCategories() {
    const site = await store.getSite();
    if (!isCurrent()) return false;
    categories = site.categories;
    renderList();
    refreshAdd();
    return true;
  }

  /** 오류를 화면에 알린다. 로그인이 풀렸으면 로그인으로, 동시 변경(충돌)이면 목록을 다시 읽는다. */
  async function report(e, what) {
    if (e instanceof AuthError) return void loseLogin();
    // 이름 바꾸기가 초안 쪽에서 토큰이 풀려 멈췄으면, 다시 읽기 전에 그 부분 실패 문구부터 로그인 화면에 남긴다.
    if (e.cause instanceof AuthError) return void loseLogin(e.message);
    if (e instanceof ConflictError) {
      status.textContent = CONFLICT_RELOAD;
      await reloadSilently();
      return;
    }
    status.textContent = `${what} ${e.message}`;
    // 이름 바꾸기가 중간에 멈췄을 수 있어(블로그만 바뀜) 목록은 다시 읽어 둔다.
    if (e.cause) await reloadSilently();
  }

  async function reloadSilently() {
    try {
      await reloadCategories();
    } catch (e) {
      if (e instanceof AuthError && isCurrent()) loseLogin();
      else if (isCurrent()) addNotice(root, `목록을 다시 불러오지 못했어요. 새로고침해 주세요. (${e.message})`);
    }
  }

  // ── 만들기 ──
  function addErrors() {
    return addName.value ? validateCategoryName(addName.value, categories) : [];
  }

  function refreshAdd() {
    const errors = addErrors();
    addError.textContent = errors.join('. ');
    addName.setAttribute('aria-invalid', String(errors.length > 0));
    addSubmit.disabled = busy || !addName.value.trim() || errors.length > 0;
  }

  addName.addEventListener('input', refreshAdd);
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || addSubmit.disabled) return;
    const name = addName.value.trim();
    setBusy(true);
    status.textContent = '만드는 중…';
    try {
      await store.addCategory(name);
      if (!isCurrent()) return;
      addName.value = '';
      status.textContent = `'${name}' 카테고리를 만들었어요. 사이트에는 배포가 끝나면 보여요.`;
      // 커밋은 끝났으니 다시 읽기가 실패해도 만들기 실패로 알리지 않는다.
      await reloadSilently();
    } catch (err) {
      if (isCurrent()) await report(err, '만들지 못했어요.');
    } finally {
      if (isCurrent()) {
        setBusy(false);
        addName.focus();
      }
    }
  });

  // ── 이름 바꾸기 ──
  function renameErrors() {
    return renameName.value.trim() === renaming ? ['지금 이름과 같아요'] : validateCategoryName(renameName.value, categories);
  }

  function refreshRename() {
    if (renaming === null) return;
    const typed = renameName.value.trim();
    // 열자마자 옛 이름이 채워져 있어 "같아요"를 바로 보이면 거슬리니, 바꾸기 시작한 뒤에만 오류를 보인다.
    const errors = renameName.value === '' || typed === renaming ? [] : renameErrors();
    renameError.textContent = errors.join('. ');
    renameName.setAttribute('aria-invalid', String(errors.length > 0));
    renameSubmit.disabled = busy || !typed || renameErrors().length > 0;
    const n = countOf(renaming);
    const count = n === null ? '글(라이브 기준)' : `글 ${n}편(라이브 기준)`;
    const code = document.createElement('code');
    code.textContent = `#/${renaming}/…`;
    renameInfo.replaceChildren(`${count}과 초안이 '${typed || '새 이름'}'으로 옮겨지고, 예전 주소 `, code, '는 끊겨요.');
  }

  function openRename(name, opener) {
    renaming = name;
    $(root, 'rename-title').textContent = `'${name}' 카테고리의 이름을 바꿔요.`;
    renameName.value = name;
    refreshRename();
    dialog.addEventListener('close', () => { renaming = null; opener.focus(); }, { once: true });
    dialog.showModal();
    renameName.select();
  }

  renameName.addEventListener('input', refreshRename);
  renameCancel.addEventListener('click', () => dialog.close());
  // 진행 중에는 Esc로도 닫히지 않는다. 커밋이 끝나기 전에 창이 사라지면 결과를 못 본다.
  dialog.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  $(root, 'rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || renameSubmit.disabled) return;
    const from = renaming;
    const to = renameName.value.trim();
    setBusy(true);
    status.textContent = '이름을 바꾸는 중…';
    try {
      const { posts, drafts } = await store.renameCategory(from, to);
      if (!isCurrent()) return;
      dialog.close();
      status.textContent = `'${from}'을 '${to}'으로 바꿨어요. 공개 글 ${posts}편과 초안 ${drafts}편을 옮겼어요.`;
      if (counts?.[from]) {
        counts[to] = counts[from];
        delete counts[from];
      }
      await reloadSilently();
    } catch (err) {
      if (!isCurrent()) return;
      dialog.close();
      await report(err, '이름을 바꾸지 못했어요.');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  });

  (async () => {
    // 목록은 다른 기기에서 바뀌었을 수 있어 화면을 열 때마다 site.json을 새로 읽는다. 글 수를 못 받아도 바꾸기는 할 수 있다.
    const [live, site] = await Promise.allSettled([fetchLive(), store.getSite()]);
    if (!isCurrent()) return;
    if (site.status === 'rejected') {
      if (site.reason instanceof AuthError) return loseLogin();
      status.textContent = `카테고리 목록을 불러오지 못했어요. ${site.reason.message}`;
      return;
    }
    if (live.status === 'fulfilled') counts = store.countByCategory(live.value);
    else addNotice(root, `${live.reason.message} 글 수는 알 수 없지만 만들기와 이름 바꾸기는 할 수 있어요.`);
    categories = site.value.categories;
    status.textContent = '';
    renderList();
    refreshAdd();
  })();

  return () => {
    if (dialog.open) dialog.close();
  };
}
