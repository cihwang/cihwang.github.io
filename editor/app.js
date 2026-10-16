/**
 * 글쓰기 화면(write.html)의 시작점: 주소 나누기, 로그인·세션, 묻기 창, 로그인 화면.
 * 목록은 screen-list.js, 쓰기는 screen-editor.js가 그린다. 각 화면 함수는 정리 함수를 돌려줘
 * 다음 화면으로 갈 때 타이머·이벤트를 걷는다. GitHub에 쓰고 읽는 흐름은 store.js가 한다.
 */
import { BLOG_REPO, AUTH_KEY } from './config.js';
import { createGitHub, GitHubError, AuthError } from './github.js';
import { createStore } from './store.js';
import { $, mount, addNotice } from './ui.js';
import { showList } from './screen-list.js';
import { showEditor } from './screen-editor.js';

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const LOGIN_LOST = '로그인이 풀렸어요. 다시 로그인하면 쓰던 글로 돌아가요.';

const askDialog = document.querySelector('[data-role="ask"]');
/** 로그인한 동안의 `{ gh, store, draftsRepo }`. 없으면 어느 주소든 로그인 화면이다. */
let session = null;
let teardown = () => {};
/** 화면이 바뀔 때마다 1씩 는다. 늦게 끝난 비동기 작업이 이미 떠난 화면을 건드리지 않게 비교한다. */
let screenId = 0;

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
  const id = screenId;
  const ctx = { session, isCurrent: () => id === screenId, ask, loseLogin };
  const { name, params } = parseHash();
  teardown = name === 'new' || name === 'edit'
    ? showEditor({ ...ctx, name, params })
    : showList({ ...ctx, logout, notice });
}

const storedAuth = readAuth();
if (storedAuth) startSession(createGitHub({ token: storedAuth.token }), storedAuth.draftsRepo);
window.addEventListener('hashchange', () => route());
route();
