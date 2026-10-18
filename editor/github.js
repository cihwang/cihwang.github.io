// 브라우저에서 GitHub REST API를 직접 부르는 유일한 모듈. 토큰은 헤더에만 싣고 어디에도 남기지 않는다.
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_RAW = 'application/vnd.github.raw+json';
const COMMIT_RETRIES = 3;

/** GitHub 요청 실패. `status`는 HTTP 상태이고, 네트워크 실패면 0이다. 메시지에 토큰은 없다. */
export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** 토큰이 만료·폐기됐거나 권한이 없을 때(401·403). */
export class AuthError extends GitHubError {
  constructor(status, message) {
    super(status, message);
    this.name = 'AuthError';
  }
}

/** 다른 곳에서 먼저 바뀐 파일과 부딪혔을 때. `path`는 충돌한 저장소 경로다. */
export class ConflictError extends GitHubError {
  constructor(status, message, path) {
    super(status, message);
    this.name = 'ConflictError';
    this.path = path;
  }
}

/**
 * 저장소 경로를 조각마다 `encodeURIComponent`로 인코딩한다. 슬래시는 유지한다.
 * @param {string} path 예: `posts/예시/a.md`
 * @returns {string} URL에 그대로 붙일 수 있는 경로
 */
export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 문자열을 UTF-8 바이트로 바꿔 base64로 만든다. 줄바꿈은 넣지 않는다.
 * @param {string} text
 * @returns {string}
 */
export function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * git이 파일 내용에 매기는 blob sha(`git hash-object`와 같다): `sha1("blob <바이트 수>\0" + 바이트)`.
 * 방금 커밋한 파일의 새 sha를 GitHub에 다시 묻지 않고 알 때 쓴다(다시 물으면 그 사이 끼어든 다른 커밋의 sha를 받을 수 있다).
 * @param {Uint8Array} bytes 올린 내용 그대로(줄바꿈 변환 없음)
 * @returns {Promise<string>} 소문자 16진수 40자
 */
export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(header.length + bytes.length);
  data.set(header);
  data.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * base64를 UTF-8 문자열로 되돌린다. GitHub가 넣는 줄바꿈·공백은 무시한다.
 * @param {string} b64
 * @returns {string}
 */
export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bytesToBase64(bytes) {
  // 한 번에 펼치면 큰 입력에서 인자 개수 한도를 넘으므로 조각으로 나눈다.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * GitHub 클라이언트를 만든다. 모든 메서드는 실패 시 `GitHubError`(401·403은 `AuthError`)를 던진다.
 * 저장소 인자는 `'owner/name'`이고, 브랜치는 저장소의 기본 브랜치를 한 번 조회해 재사용한다.
 * @param {{ token: string, fetch?: typeof fetch }} options 테스트에서는 가짜 fetch를 넣는다.
 */
export function createGitHub({ token, fetch = globalThis.fetch }) {
  const branchByRepo = new Map();

  /** 요청을 보내고, `allow`에 든 상태가 아니면 오류로 바꿔 던진다. */
  async function request(method, path, { body, accept = ACCEPT_JSON, allow = [] } = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
    };
    // 인증된 GET이 max-age=60으로 캐시되면 재시도·저장 직후 읽기가 옛 값을 본다.
    const init = { method, headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${API}${path}`, init);
    } catch {
      throw new GitHubError(0, `GitHub에 연결하지 못했어요. 네트워크를 확인해 주세요. (${method} ${path})`);
    }
    if (res.ok || allow.includes(res.status)) return res;
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(res.status, `GitHub 인증에 실패했어요. 토큰이 만료됐거나 권한이 부족해요. (HTTP ${res.status}, ${method} ${path})`);
    }
    throw new GitHubError(res.status, `GitHub 요청에 실패했어요. (HTTP ${res.status}, ${method} ${path})`);
  }

  const json = async (method, path, opts) => (await request(method, path, opts)).json();

  /** 저장소 정보. `defaultBranch`는 이후 트리·커밋 조회에 쓰려고 캐시한다. */
  async function getRepo(repo) {
    const r = await json('GET', `/repos/${repo}`);
    branchByRepo.set(repo, r.default_branch);
    return { private: r.private, push: Boolean(r.permissions?.push), defaultBranch: r.default_branch };
  }

  async function branchOf(repo) {
    return branchByRepo.get(repo) ?? (await getRepo(repo)).defaultBranch;
  }

  /** 파일 텍스트와 sha. 파일이 없으면(404) null. 줄바꿈은 손대지 않는다. */
  async function getFile(repo, path) {
    const url = `/repos/${repo}/contents/${encodePath(path)}`;
    const res = await request('GET', url, { allow: [404] });
    if (res.status === 404) return null;
    const meta = await res.json();
    if (meta.encoding === 'base64' && meta.content) return { text: base64ToUtf8(meta.content), sha: meta.sha };
    // 1MB가 넘으면 content가 비어 오므로 raw로 다시 받는다.
    const raw = await request('GET', url, { accept: ACCEPT_RAW });
    return { text: await raw.text(), sha: meta.sha };
  }

  /** 파일 바이트를 Blob으로. 없으면(404) null. 비공개 저장소 사진 미리보기용. */
  async function getRaw(repo, path) {
    const res = await request('GET', `/repos/${repo}/contents/${encodePath(path)}`, { accept: ACCEPT_RAW, allow: [404] });
    return res.status === 404 ? null : res.blob();
  }

  /**
   * 파일을 만들거나 고친다. 새 파일은 `sha` 없이, 기존 파일은 읽어 둔 `sha`와 함께 보낸다.
   * 409, 또는 `sha` 없이 기존 파일을 덮으려다 난 422는 `ConflictError`.
   * @returns {Promise<{ sha: string }>} 새 파일 sha
   */
  async function putFile(repo, path, { text, base64, sha, message }) {
    const body = { message, content: base64 ?? utf8ToBase64(text) };
    if (sha) body.sha = sha;
    try {
      const r = await json('PUT', `/repos/${repo}/contents/${encodePath(path)}`, { body });
      return { sha: r.content.sha };
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || (e.status === 422 && !sha))) {
        throw new ConflictError(e.status, `다른 곳에서 먼저 바뀐 파일이에요. 새로 불러온 뒤 다시 시도해 주세요. (HTTP ${e.status}, ${path})`, path);
      }
      throw e;
    }
  }

  /** 파일을 지운다. 이미 없으면(404) 성공으로 본다. */
  async function deleteFile(repo, path, sha, message) {
    await request('DELETE', `/repos/${repo}/contents/${encodePath(path)}`, { body: { message, sha }, allow: [404] });
  }

  /** 기본 브랜치의 전체 트리. 커밋이 하나도 없는 저장소(409)는 빈 배열. */
  async function listTree(repo) {
    const branch = await branchOf(repo);
    const res = await request('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { allow: [409] });
    return res.status === 409 ? [] : (await res.json()).tree;
  }

  /** 경로를 마지막으로 바꾼 커밋의 committer 날짜(ISO). 커밋이 없으면 null. */
  async function lastCommitDate(repo, path) {
    const list = await json('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`);
    return list[0]?.commit.committer.date ?? null;
  }

  /** blob 내용을 줄바꿈 없는 base64로. */
  async function getBlobBase64(repo, sha) {
    const b = await json('GET', `/repos/${repo}/git/blobs/${sha}`);
    return b.content.replace(/\s/g, '');
  }

  async function tryCommit(repo, branch, { message, files, deletes, expect }) {
    const ref = await json('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const parentSha = ref.object.sha;
    const parent = await json('GET', `/repos/${repo}/git/commits/${parentSha}`);
    const baseTree = parent.tree.sha;

    const paths = Object.keys(expect);
    if (paths.length) {
      const current = new Map((await json('GET', `/repos/${repo}/git/trees/${baseTree}?recursive=1`)).tree.map((t) => [t.path, t.sha]));
      for (const path of paths) {
        if ((current.get(path) ?? null) !== expect[path]) {
          throw new ConflictError(409, `다른 곳에서 먼저 바뀐 파일이 있어요. 새로 불러온 뒤 다시 시도해 주세요. (${path})`, path);
        }
      }
    }

    const entries = [];
    for (const { path, base64 } of files) {
      const blob = await json('POST', `/repos/${repo}/git/blobs`, { body: { content: base64, encoding: 'base64' } });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const path of deletes) entries.push({ path, mode: '100644', type: 'blob', sha: null });

    const tree = await json('POST', `/repos/${repo}/git/trees`, { body: { base_tree: baseTree, tree: entries } });
    const commit = await json('POST', `/repos/${repo}/git/commits`, { body: { message, tree: tree.sha, parents: [parentSha] } });
    const moved = await request('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { body: { sha: commit.sha }, allow: [422] });
    return moved.status === 422 ? null : commit.sha;
  }

  /**
   * 파일 추가·수정·삭제를 한 커밋으로 올린다.
   * `expect`는 경로별로 기대하는 현재 sha(null은 "없어야 함")이고, 다르면 아무것도 만들기 전에 `ConflictError`.
   * 그 사이 다른 커밋이 끼어들어 ref 갱신(PATCH)이 422면 처음부터 최대 3번 다시 시도(첫 시도 포함 4번)하고, 그래도 안 되면 422 `GitHubError`.
   * 다른 단계의 422는 재시도 없이 바로 던진다.
   * @param {string} repo
   * @param {{ message: string, files: { path: string, base64: string }[], deletes: string[], expect: Record<string, string|null> }} change
   * @returns {Promise<{ commitSha: string }>}
   */
  async function commitFiles(repo, change) {
    const branch = await branchOf(repo);
    for (let attempt = 0; attempt <= COMMIT_RETRIES; attempt += 1) {
      const commitSha = await tryCommit(repo, branch, change);
      if (commitSha) return { commitSha };
    }
    throw new GitHubError(422, `다른 곳에서 계속 커밋이 올라와 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요. (HTTP 422, ${repo} ref 갱신)`);
  }

  return { getRepo, getFile, getRaw, putFile, deleteFile, listTree, lastCommitDate, getBlobBase64, commitFiles };
}
