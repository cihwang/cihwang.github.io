/**
 * 글쓰기 화면(write.html). 로그인 → 임시글 목록(`#/`) → 쓰기(`#/new`, `#/edit?repo=drafts|blog&path=…`).
 * 화면마다 `show…` 함수가 하나씩 있고, 각자 정리 함수를 돌려줘 다음 화면으로 갈 때 타이머·이벤트를 걷는다.
 * GitHub에 쓰고 읽는 흐름은 store.js가 하고, 이 파일은 무엇을 보여 주고 언제 부를지만 정한다.
 */
import { renderMarkdown } from '../markdown.js';
import { BLOG_REPO, SITE_URL, AUTH_KEY, AUTOSAVE_MS } from './config.js';
import { createGitHub, GitHubError, AuthError, ConflictError } from './github.js';
import { createStore } from './store.js';
import { createLocal } from './local.js';
import { applyFormat } from './format.js';

const PREVIEW_MS = 150;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const KIND_LABEL = { editing: '고치는 중', 'public-draft': '공개 저장소에 있음', local: '이 기기에만 있음' };
const LOGIN_LOST = '로그인이 풀렸어요. 다시 로그인하면 쓰던 글로 돌아가요.';
const CONFLICT_TEXT = '다른 기기에서 먼저 저장했어요. 덮어쓰지 않았고, 이 기기 내용은 그대로 남겨 뒀어요.';

const app = document.querySelector('[data-role="app"]');
const askDialog = document.querySelector('[data-role="ask"]');
const local = createLocal();
/** 로그인한 동안의 `{ gh, store, draftsRepo }`. 없으면 어느 주소든 로그인 화면이다. */
let session = null;
let teardown = () => {};
/** 화면이 바뀔 때마다 1씩 는다. 늦게 끝난 비동기 작업이 이미 떠난 화면을 건드리지 않게 비교한다. */
let screenId = 0;

const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
const pad = (n) => String(n).padStart(2, '0');
const clockText = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const editHash = (repo, path) => `#/edit?repo=${repo}&path=${encodeURIComponent(path)}`;
/** 머리말 키 순서와 상관없이 같은 내용이면 같은 문자열. GitHub에 올라간 내용과 비교하는 데 쓴다. */
const snapshot = (meta, body) => JSON.stringify([Object.entries(meta).sort(), body]);
const failText = (e) => (e instanceof ConflictError ? CONFLICT_TEXT : e.message);

function cloneTemplate(name) {
  return document.querySelector(`template[data-tpl="${name}"]`).content.firstElementChild.cloneNode(true);
}

function mount(name) {
  const node = cloneTemplate(name);
  app.replaceChildren(node);
  return node;
}

function addNotice(root, text) {
  const p = document.createElement('p');
  p.className = 'ed-notice';
  p.textContent = text;
  $(root, 'notices').append(p);
}

const relative = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];

/** ISO 시각을 "3시간 전" 같은 말로. 1분 안이면 "방금". */
function relativeTime(iso) {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  const unit = UNITS.find(([, size]) => Math.abs(sec) >= size);
  return unit ? relative.format(Math.round(sec / unit[1]), unit[0]) : '방금';
}

/**
 * 묻기 창을 띄우고 고른 단추의 `value`를 돌려준다. Esc로 닫으면 빈 문자열.
 * @param {string} message 해요체 질문
 * @param {{ label: string, value: string, primary?: boolean }[]} choices 처음 것에 초점이 간다(지우기처럼 되돌릴 수 없는 일은 취소를 처음에).
 */
function ask(message, choices) {
  $(askDialog, 'ask-text').textContent = message;
  $(askDialog, 'ask-actions').replaceChildren(...choices.map(({ label, value, primary }) => {
    const button = document.createElement('button');
    button.className = primary ? 'ed-btn is-primary' : 'ed-btn';
    button.value = value;
    button.textContent = label;
    return button;
  }));
  askDialog.returnValue = '';
  askDialog.showModal();
  return new Promise((resolve) => askDialog.addEventListener('close', () => resolve(askDialog.returnValue), { once: true }));
}

// ── 로그인 ──────────────────────────────────────────────

/** 이 기기에 저장된 `{ token, draftsRepo }`. 없거나 깨졌거나 저장소를 읽을 수 없으면 null. */
function readAuth() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_KEY);
  } catch {
    // 사생활 보호 모드 등에서 저장소를 못 읽으면 저장된 로그인도 없는 것과 같다.
    return null;
  }
  try {
    const auth = JSON.parse(raw);
    return typeof auth?.token === 'string' && typeof auth?.draftsRepo === 'string' ? auth : null;
  } catch {
    // 깨진 값은 로그인이 없는 것으로 보고, 새로 로그인하면 덮어쓴다.
    return null;
  }
}

function startSession(gh, draftsRepo) {
  session = { gh, draftsRepo, store: createStore({ gh, draftsRepo }) };
}

function repoProblem(e, what) {
  if (e instanceof AuthError) return '토큰이 맞지 않거나 만료됐어요. 토큰을 다시 확인해 주세요.';
  if (e instanceof GitHubError && e.status === 404) return `${what}를 찾지 못했어요. 이름과 토큰의 Repository access를 확인해 주세요.`;
  return e.message;
}

/** 두 저장소를 확인해 무엇이 틀렸는지 해요체 한 문장으로. 모두 맞으면 null. */
async function checkLogin(gh, draftsRepo) {
  let blog;
  let drafts;
  try {
    blog = await gh.getRepo(BLOG_REPO);
  } catch (e) {
    return repoProblem(e, `블로그 저장소(${BLOG_REPO})`);
  }
  if (!blog.push) return `토큰에 블로그 저장소(${BLOG_REPO})에 쓸 권한이 없어요. Contents를 Read and write로 해 주세요.`;
  try {
    drafts = await gh.getRepo(draftsRepo);
  } catch (e) {
    return repoProblem(e, `초안 저장소(${draftsRepo})`);
  }
  if (drafts.private !== true) return `초안 저장소(${draftsRepo})가 공개 저장소예요. 초안이 남에게 보이지 않게 비공개 저장소만 쓸 수 있어요.`;
  if (!drafts.push) return `토큰에 초안 저장소(${draftsRepo})에 쓸 권한이 없어요. Contents를 Read and write로 해 주세요.`;
  return null;
}

function showLogin(notice) {
  const root = mount('login');
  const form = $(root, 'login-form');
  const msg = $(root, 'login-msg');
  const submit = $(root, 'login-submit');
  const { token: tokenInput, draftsRepo: repoInput } = form.elements;
  if (notice) addNotice(root, notice);
  repoInput.value = readAuth()?.draftsRepo ?? '';
  const fail = (text, input) => {
    msg.textContent = text;
    input?.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    const draftsRepo = repoInput.value.trim();
    if (!token) return fail('토큰을 넣어 주세요.', tokenInput);
    if (!REPO_NAME.test(draftsRepo)) return fail('초안 저장소는 owner/name 모양으로 적어 주세요. 예: cihwang/blog-drafts', repoInput);
    if (draftsRepo.toLowerCase() === BLOG_REPO.toLowerCase()) return fail('초안 저장소는 블로그 저장소와 다른 비공개 저장소여야 해요.', repoInput);
    submit.disabled = true;
    msg.textContent = '확인하는 중…';
    const gh = createGitHub({ token });
    const problem = await checkLogin(gh, draftsRepo);
    submit.disabled = false;
    if (problem) return fail(problem);
    let saveNote = null;
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ token, draftsRepo }));
    } catch {
      saveNote = '이 기기에 로그인 정보를 저장하지 못했어요. 새로고침하면 다시 로그인해야 해요.';
    }
    tokenInput.value = '';
    startSession(gh, draftsRepo);
    route(saveNote);
  });
  (repoInput.value ? tokenInput : repoInput).focus();
  return () => {};
}

function logout() {
  let note = null;
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    note = '이 기기에서 토큰을 지우지 못했어요. 브라우저의 사이트 데이터를 지워 주세요.';
  }
  session = null;
  route(note);
}

/** 토큰이 풀렸을 때: 지금 주소는 그대로 두고 로그인 화면으로. 다시 로그인하면 `route()`가 같은 글을 연다. */
function loseLogin() {
  session = null;
  route(LOGIN_LOST);
}

/** 사이트에 지금 공개된 글들(`posts.json`). 배포 캐시를 피하려고 시각을 붙인다. */
async function fetchLive() {
  let res;
  try {
    res = await fetch(`${SITE_URL}posts.json?t=${Date.now()}`, { cache: 'no-store' });
  } catch {
    throw new Error('사이트 글 목록(posts.json)을 불러오지 못했어요. 네트워크를 확인해 주세요.');
  }
  if (!res.ok) throw new Error(`사이트 글 목록(posts.json)을 불러오지 못했어요. (HTTP ${res.status})`);
  try {
    const { posts = [] } = await res.json();
    return posts;
  } catch (e) {
    throw new Error('사이트 글 목록(posts.json)을 읽지 못했어요. 배포가 덜 끝났을 수 있어요.', { cause: e });
  }
}

// ── 임시글 목록 ─────────────────────────────────────────

/** 이 기기에만 있고 GitHub에 올린 적 없는 새 글(`new:` 키)들. 창을 닫았다 열어도 이어 쓸 수 있게 목록에 같이 보여 준다. */
function localOnlyDrafts() {
  return local.keys().filter((k) => k.startsWith('new:')).map((key) => {
    const saved = local.load(key);
    return saved && { key, kind: 'local', title: saved.meta?.title ?? '', category: saved.meta?.category ?? '', updated: saved.savedAt ?? null };
  }).filter(Boolean);
}

function draftRow(draft, { onOpen, onDelete }) {
  const row = cloneTemplate('draft-row');
  const name = draft.title || '(제목 없음)';
  $(row, 'title').textContent = name;
  $(row, 'cat').textContent = draft.category || '카테고리 없음';
  if (draft.updated) {
    const time = $(row, 'time');
    time.dateTime = draft.updated;
    time.textContent = relativeTime(draft.updated);
    time.title = new Date(draft.updated).toLocaleString('ko-KR');
  }
  if (KIND_LABEL[draft.kind]) {
    const badge = $(row, 'kind');
    badge.textContent = KIND_LABEL[draft.kind];
    badge.hidden = false;
  }
  const open = $(row, 'open');
  const del = $(row, 'delete');
  open.setAttribute('aria-label', `${name} 이어 쓰기`);
  del.setAttribute('aria-label', `${name} 삭제`);
  open.addEventListener('click', () => onOpen(draft));
  del.addEventListener('click', () => onDelete(draft, row));
  return row;
}

function deleteQuestion(draft) {
  const name = draft.title || '(제목 없음)';
  if (draft.kind === 'public-draft') return `"${name}" 글을 공개 저장소에서 지울까요? 블로그 저장소에 커밋이 하나 생기고, 되돌릴 수 없어요.`;
  if (draft.kind === 'editing') return `"${name}"의 고치던 내용을 지울까요? 사이트에 공개된 글은 그대로예요.`;
  if (draft.kind === 'local') return `"${name}" 글을 이 기기에서 지울까요? GitHub에 올린 적 없는 글이라 되돌릴 수 없어요.`;
  return `"${name}" 초안을 지울까요? 되돌릴 수 없어요.`;
}

function showList(id, notice) {
  const root = mount('list');
  const status = $(root, 'status');
  const list = $(root, 'drafts');
  const { store, gh, draftsRepo } = session;
  const failed = (e, what) => {
    if (id !== screenId) return;
    if (e instanceof AuthError) return loseLogin();
    status.textContent = `${what} ${failText(e)}`;
  };
  if (notice) addNotice(root, notice);
  $(root, 'logout').addEventListener('click', logout);

  async function openDraft(draft) {
    if (draft.kind === 'local') return void (location.hash = `#/new?local=${encodeURIComponent(draft.key)}`);
    if (draft.kind !== 'public-draft') return void (location.hash = editHash('drafts', draft.path));
    const choice = await ask('이 글은 공개 저장소에 있어서 누구나 GitHub에서 읽을 수 있어요. 비공개 초안 저장소로 옮긴 뒤 이어 쓸까요?', [
      { label: '취소', value: '' },
      { label: '옮기고 이어 쓰기', value: 'move', primary: true },
    ]);
    if (choice !== 'move' || id !== screenId) return;
    status.textContent = '초안 저장소로 옮기는 중…';
    try {
      await store.moveToDrafts(draft.path);
      if (id === screenId) location.hash = editHash('drafts', draft.path);
    } catch (e) {
      failed(e, '옮기지 못했어요.');
    }
  }

  async function deleteDraft(draft, row) {
    const choice = await ask(deleteQuestion(draft), [{ label: '취소', value: '' }, { label: '삭제', value: 'delete', primary: true }]);
    if (choice !== 'delete' || id !== screenId) return;
    status.textContent = '지우는 중…';
    try {
      if (draft.kind === 'public-draft') {
        await store.deletePost(draft.path);
      } else if (draft.kind !== 'local') {
        const file = await gh.getFile(draftsRepo, draft.path);
        if (file) await store.deleteDraft(draft.path, file.sha);
      }
    } catch (e) {
      return failed(e, '지우지 못했어요.');
    }
    // 원격을 지운 뒤에만 기기 저장본을 지운다. 순서가 반대면 원격 삭제 실패 때 쓰던 내용이 사라진다.
    let note = '지웠어요.';
    try {
      local.clear(draft.key ?? draft.path);
    } catch (e) {
      if (draft.kind === 'local') return void (status.textContent = `지우지 못했어요. ${e.message}`);
      note = `GitHub에서는 지웠지만 ${e.message}`;
    }
    row.remove();
    status.textContent = note;
  }

  const actions = { onOpen: openDraft, onDelete: deleteDraft };
  list.append(...localOnlyDrafts().map((d) => draftRow(d, actions)));

  (async () => {
    // 카테고리는 다른 기기에서 바뀌었을 수 있어 화면을 열 때마다 site.json을 새로 읽는다.
    const [live, site] = await Promise.allSettled([fetchLive(), store.getSite()]);
    if (id !== screenId) return;
    if (site.status === 'rejected' && site.reason instanceof AuthError) return loseLogin();
    if (live.status === 'rejected') addNotice(root, `${live.reason.message} "고치는 중" 표시가 빠질 수 있어요.`);
    if (site.status === 'rejected') addNotice(root, `카테고리 목록을 불러오지 못했어요. ${site.reason.message}`);
    try {
      const drafts = await store.listDrafts(live.value ?? []);
      if (id !== screenId) return;
      list.append(...drafts.map((d) => draftRow(d, actions)));
      status.textContent = list.children.length ? '' : '임시글이 없어요.';
    } catch (e) {
      failed(e, '임시글을 불러오지 못했어요.');
    }
  })();
  return () => {};
}

// ── 쓰기 ────────────────────────────────────────────────

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

/** 기기 저장본에서 Doc 칸만 꺼낸다. 모양이 깨졌으면 null. */
function docFromSaved(saved) {
  if (!saved || typeof saved.body !== 'string' || typeof saved.meta !== 'object' || !saved.meta) return null;
  const { meta, body, draftPath = null, draftSha = null, blogPath = null, blogSha = null } = saved;
  return { meta: { ...meta }, body, draftPath, draftSha, blogPath, blogSha };
}

function showEditor(name, params, id) {
  const root = mount('editor');
  const el = Object.fromEntries(['title', 'cats', 'toolbar', 'body', 'preview-title', 'preview-body', 'bar', 'status', 'exit', 'save', 'publish']
    .map((role) => [role, $(root, role)]));
  const { store, gh, draftsRepo } = session;
  let doc = null;
  let key = null;          // 기기 저장 키: draftPath, 없으면 blogPath, 없으면 new:<랜덤>
  let synced = '';         // GitHub에 있는 내용의 snapshot. 지금 내용과 다르면 올리지 않은 변경이 있다.
  let lastSync = null;     // 마지막으로 GitHub 내용과 같았던 시각(ISO). 새 글은 null.
  let localPending = false; // 마지막 기기 저장 뒤 바뀐 것이 있다
  let saving = false;
  let autosaveTimer = 0;
  let previewTimer = 0;
  // 'media/…' → blob URL | null(초안 저장소에 없음 → 사이트 주소) | 'pending'
  const media = new Map();
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

  /** 지금 내용을 기기에 저장한다. 실패하면 상태 글에 이유를 쓰고 false. */
  function saveLocal() {
    clearTimeout(autosaveTimer);
    if (!doc) return true;
    const now = new Date().toISOString();
    try {
      local.save(key, { ...doc, savedAt: now, remoteSavedAt: dirty() ? lastSync : now });
      localPending = false;
      return true;
    } catch (e) {
      setStatus(`저장 실패: ${e.message}`);
      return false;
    }
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

  async function fetchMedia(path) {
    media.set(path, 'pending');
    let url = null;
    try {
      const blob = await gh.getRaw(draftsRepo, path);
      url = blob && URL.createObjectURL(blob);
    } catch {
      // 미리보기만의 일이다. 초안 저장소에서 못 받으면 사이트 주소로 보여 주고, 인증·저장 오류는 저장할 때 알린다.
    }
    if (id !== screenId) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    media.set(path, url);
    renderPreview();
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    el['preview-title'].textContent = doc.meta.title ?? '';
    const tpl = document.createElement('template');
    tpl.innerHTML = renderMarkdown(doc.body);
    // 초안 저장소는 비공개라 주소로는 못 받는다. 토큰으로 받은 blob으로 바꾸고, 없으면 사이트에 이미 있는 사진으로 본다.
    for (const node of tpl.content.querySelectorAll('img[src^="media/"], video[src^="media/"]')) {
      const path = node.getAttribute('src');
      const url = media.get(path);
      if (url === undefined) fetchMedia(path);
      if (url === undefined || url === 'pending') node.removeAttribute('src');
      else node.src = url ?? SITE_URL + path;
    }
    el['preview-body'].replaceChildren(tpl.content);
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
    if (id === screenId) history.replaceState(null, '', editHash('drafts', next));
  }

  async function saveRemote() {
    if (!doc || saving) return;
    // 이미 초안 저장소와 같은 내용이면 빈 커밋을 만들지 않는다.
    if (doc.draftPath && !dirty()) return setStatus('바뀐 내용이 없어요.');
    saving = true;
    // GitHub가 실패해도 쓰던 내용이 남도록 기기에 먼저 저장한다.
    saveLocal();
    setStatus('저장하는 중…');
    const sent = { ...doc, meta: { ...doc.meta } };
    try {
      const saved = await store.saveDraft(sent);
      // 기다리는 동안 더 쓴 내용은 doc에 그대로 두고, 경로·sha만 받아 온다.
      Object.assign(doc, { draftPath: saved.draftPath, draftSha: saved.draftSha });
      doc.meta.draft = saved.meta.draft;
      synced = snapshot(saved.meta, sent.body);
      lastSync = new Date().toISOString();
      if (key !== saved.draftPath) moveKey(saved.draftPath);
      saveLocal();
      setStatus(`저장됨 · ${clockText(new Date())}${dirty() ? ' (그 뒤 고친 내용은 이 기기에만 있어요)' : ''}`);
    } catch (e) {
      if (e instanceof AuthError) {
        saveLocal();
        if (id === screenId) loseLogin();
        return;
      }
      setStatus(`저장 실패: ${failText(e)}`);
    } finally {
      saving = false;
    }
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
    el.cats.replaceChildren(...categories.map((c) => {
      const label = document.createElement('label');
      label.className = 'ed-pill';
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'category', value: c, checked: c === doc.meta.category });
      const text = document.createElement('span');
      text.textContent = c;
      label.append(input, text);
      return label;
    }));
  }

  function wire() {
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
      else if (button?.dataset.action === 'photo') setStatus('사진 올리기는 아직 준비 중이에요.');
    });
    listen(el.save, 'click', saveRemote);
    listen(el.publish, 'click', () => setStatus('출간은 아직 준비 중이에요. 지금은 임시저장만 할 수 있어요.'));
    listen(el.exit, 'click', async () => {
      if (dirty()) {
        const choice = await ask('GitHub에 올리지 않은 변경이 있어요. 이 기기에는 남겨 둘게요. 나갈까요?', [
          { label: '계속 쓰기', value: '' },
          { label: '나가기', value: 'leave', primary: true },
        ]);
        if (choice !== 'leave' || id !== screenId) return;
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
    listen(el['preview-body'], 'click', (e) => {
      const link = e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href.startsWith('#')) el['preview-body'].querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
      else window.open(link.href, '_blank', 'noopener');
    });
    listen(window, 'beforeunload', (e) => {
      if (localPending) saveLocal();
      if (!dirty()) return;
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
  listen(document, 'keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      saveRemote();
    } else if ((k === 'b' || k === 'i') && doc && document.activeElement === el.body) {
      e.preventDefault();
      format(k === 'b' ? 'bold' : 'italic');
    }
  });

  /** 주소에 맞는 글을 연다. `{ remote, saved, blank }`: GitHub 내용(새 글이면 null), 기기 저장본, 새 글의 빈 Doc. */
  async function loadDoc() {
    if (name === 'new') {
      key = params.get('local');
      if (!key) {
        // 새로고침·로그인 풀림 뒤에도 같은 기기 저장본으로 돌아오게 키를 주소에 남긴다.
        key = `new:${crypto.randomUUID().slice(0, 8)}`;
        history.replaceState(null, '', `#/new?local=${encodeURIComponent(key)}`);
      }
      return { remote: null, saved: docFromSaved(local.load(key)), blank: store.newDoc('') };
    }
    const repo = params.get('repo') === 'blog' ? 'blog' : 'drafts';
    const path = params.get('path') ?? '';
    // 빈 경로로 Contents API를 부르면 저장소 맨 위 폴더 목록이 와서 글처럼 열린다.
    if (!path.endsWith('.md')) throw new Error(`글 파일 주소가 아니에요. (${path || '빈 주소'})`);
    const remote = await store.open({ repo, path });
    key = remote.draftPath ?? remote.blogPath;
    return { remote, saved: local.load(key) };
  }

  /**
   * GitHub 내용과 기기 저장본 중 어느 쪽으로 이어 쓸지 정한다. 기기에 올리지 않은 다른 내용이 있을 때만 묻는다.
   * @returns {Promise<{ doc: object, dropLocal: boolean }>} `dropLocal`: GitHub 쪽을 골라 기기 저장본을 덮어야 함
   */
  async function chooseDoc(remote, saved) {
    const savedDoc = docFromSaved(saved);
    const unsynced = savedDoc && (saved.savedAt ?? '') > (saved.remoteSavedAt ?? '')
      && snapshot(savedDoc.meta, savedDoc.body) !== snapshot(remote.meta, remote.body);
    if (!unsynced) return { doc: remote, dropLocal: false };
    const when = saved.savedAt ? ` (${new Date(saved.savedAt).toLocaleString('ko-KR')} 저장)` : '';
    const moved = savedDoc.draftSha !== remote.draftSha || savedDoc.blogSha !== remote.blogSha;
    const choice = await ask(
      `이 기기에 더 최근 내용이 있어요${when}. ${moved ? 'GitHub 쪽도 그 뒤에 다른 곳에서 바뀌었어요. ' : ''}`
        + '어느 쪽으로 이어 쓸까요? GitHub 내용을 고르면 이 기기 내용은 지워져요.',
      [{ label: 'GitHub 내용', value: 'remote' }, { label: '이 기기 내용', value: 'local', primary: true }],
    );
    // 창을 그냥 닫으면 지우지 않는 쪽(기기 내용)으로 간다. 고른 기기 내용은 지금 GitHub sha 위에 얹는다.
    return choice === 'remote'
      ? { doc: remote, dropLocal: true }
      : { doc: { ...remote, meta: savedDoc.meta, body: savedDoc.body }, dropLocal: false };
  }

  function showLoadError(message) {
    const box = document.createElement('section');
    box.className = 'ed-page';
    const p = document.createElement('p');
    p.className = 'ed-notice';
    p.setAttribute('role', 'alert');
    p.textContent = `글을 불러오지 못했어요. ${message}`;
    const back = Object.assign(document.createElement('a'), { href: '#/', className: 'ed-btn', textContent: '목록으로' });
    box.append(p, back);
    app.replaceChildren(box);
  }

  (async () => {
    setStatus('불러오는 중…');
    // 카테고리는 다른 기기에서 바뀌었을 수 있어 화면을 열 때마다 site.json을 새로 읽는다.
    const [site, live, opened] = await Promise.allSettled([store.getSite(), fetchLive(), loadDoc()]);
    if (id !== screenId) return;
    if ([site, live, opened].some((r) => r.status === 'rejected' && r.reason instanceof AuthError)) return loseLogin();
    if (opened.status === 'rejected') return showLoadError(opened.reason.message);
    const { remote, saved, blank } = opened.value;
    const picked = remote ? await chooseDoc(remote, saved) : { doc: saved ?? blank, dropLocal: false };
    if (id !== screenId) return;
    doc = picked.doc;
    const base = remote ?? blank;
    synced = snapshot(base.meta, base.body);
    lastSync = remote ? new Date().toISOString() : null;
    if (picked.dropLocal) saveLocal();
    if (site.status === 'rejected') addNotice(root, `카테고리 목록을 불러오지 못했어요. 임시저장 전에 새로고침해 주세요. (${site.reason.message})`);
    // 라이브 글 목록은 출간 검사에 쓴다. 못 받아도 쓰기는 계속할 수 있다.
    if (live.status === 'rejected') addNotice(root, `${live.reason.message} 쓰기와 임시저장은 그대로 할 수 있어요.`);
    renderCats(site.value?.categories ?? []);
    el.title.value = doc.meta.title ?? '';
    el.body.value = doc.body;
    el.publish.textContent = doc.blogPath ? '수정하기' : '출간하기';
    renderPreview();
    setStatus(dirty() ? '이 기기에만 저장됨' : '');
    wire();
  })();

  return () => {
    if (localPending) saveLocal();
    clearTimeout(autosaveTimer);
    clearTimeout(previewTimer);
    for (const off of cleanups) off();
    for (const url of media.values()) if (url && url !== 'pending') URL.revokeObjectURL(url);
  };
}

// ── 주소 ────────────────────────────────────────────────

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: path || 'list', params: new URLSearchParams(query) };
}

/** 지금 주소의 화면을 그린다. 로그인이 없으면 어느 주소든 로그인 화면(주소는 그대로 두어 로그인 뒤 돌아온다). */
function route(notice = null) {
  teardown();
  screenId += 1;
  if (askDialog.open) askDialog.close();
  if (!session) {
    teardown = showLogin(notice);
    return;
  }
  const { name, params } = parseHash();
  teardown = name === 'new' || name === 'edit' ? showEditor(name, params, screenId) : showList(screenId, notice);
}

const storedAuth = readAuth();
if (storedAuth) startSession(createGitHub({ token: storedAuth.token }), storedAuth.draftsRepo);
window.addEventListener('hashchange', () => route());
route();
