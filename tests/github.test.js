import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHub, GitHubError, AuthError, ConflictError,
  encodePath, utf8ToBase64, base64ToUtf8, gitBlobSha,
} from '../editor/github.js';

const TOKEN = 'ghp_SECRET_TOKEN';

/** 요청을 기록하고 handler(req)가 돌려준 { status, json, text }로 답하는 가짜 fetch. */
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const req = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const res = handler(req, calls.length - 1);
    return new Response(res.json !== undefined ? JSON.stringify(res.json) : (res.text ?? ''), { status: res.status ?? 200 });
  };
  return { fetch, calls };
}

function client(handler) {
  const f = fakeFetch(handler);
  return { gh: createGitHub({ token: TOKEN, fetch: f.fetch }), calls: f.calls };
}

test('UTF-8 base64 왕복과 줄바꿈 섞인 base64', () => {
  const text = '한글 😀\n';
  assert.equal(base64ToUtf8(utf8ToBase64(text)), text, '되돌리면 그대로');
  const b64 = utf8ToBase64('가나다라마바사'.repeat(20));
  const wrapped = b64.replace(/(.{60})/g, '$1\n');
  assert.equal(base64ToUtf8(wrapped), '가나다라마바사'.repeat(20), '60자마다 줄바꿈이 있어도 읽는다');
  assert.equal(encodePath('posts/예시/a b.md'), 'posts/%EC%98%88%EC%8B%9C/a%20b.md', '조각마다 인코딩, 슬래시는 유지');
});

test('gitBlobSha: git hash-object와 같은 blob sha(바이트 그대로, CRLF·한글·이모지 포함)', async () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(await gitBlobSha(bytes('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', '빈 파일의 잘 알려진 blob sha');
  assert.equal(await gitBlobSha(bytes('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'git hash-object와 같다');
  assert.equal(await gitBlobSha(bytes('가 😀\r\n')), '1d8b2399e8897125587fef304528f0f6f2bf6118', '길이는 글자 수가 아니라 UTF-8 바이트 수, CRLF는 그대로');
});

test('getFile: URL 인코딩, 헤더, 디코딩', async () => {
  const { gh, calls } = client(() => ({ json: { content: utf8ToBase64('본문\r\n').replace(/(.{60})/g, '$1\n'), encoding: 'base64', sha: 's1' } }));
  const r = await gh.getFile('o/r', 'posts/예시/공부-01.md');
  assert.deepEqual(r, { text: '본문\r\n', sha: 's1' }, '텍스트는 그대로, sha 함께');
  assert.ok(calls[0].url.endsWith('/repos/o/r/contents/posts/%EC%98%88%EC%8B%9C/%EA%B3%B5%EB%B6%80-01.md'), 'URL 끝 경로');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`, '토큰 헤더');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json', 'Accept 헤더');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28', 'API 버전 헤더');
});

test('getFile: 1MB 넘는 파일은 raw로 다시 받는다', async () => {
  const { gh, calls } = client((req, i) => i === 0
    ? { json: { content: '', encoding: 'none', sha: 'big' } }
    : { text: '큰 글' });
  const r = await gh.getFile('o/r', 'posts/big.md');
  assert.deepEqual(r, { text: '큰 글', sha: 'big' }, 'raw 본문과 첫 응답의 sha');
  assert.equal(calls[1].headers.Accept, 'application/vnd.github.raw+json', '두 번째는 raw 미디어 타입');
});

test('getRaw: Blob 또는 null', async () => {
  const { gh, calls } = client(() => ({ text: 'abc' }));
  const blob = await gh.getRaw('o/r', 'media/a.png');
  assert.equal(await blob.text(), 'abc', '바이트를 Blob으로');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw+json', 'raw Accept');
  const miss = client(() => ({ status: 404, json: {} }));
  assert.equal(await miss.gh.getRaw('o/r', 'x'), null, '404는 null');
});

test('404: getFile은 null, deleteFile은 성공', async () => {
  const { gh } = client(() => ({ status: 404, json: { message: 'Not Found' } }));
  assert.equal(await gh.getFile('o/r', 'a.md'), null, 'getFile 404는 null');
  assert.equal(await gh.deleteFile('o/r', 'a.md', 'sha', 'msg'), undefined, 'deleteFile 404는 이미 지워진 것');
});

test('오류 매핑: 401·403은 AuthError, 409는 ConflictError, 메시지에 토큰 없음', async () => {
  for (const status of [401, 403]) {
    const { gh } = client(() => ({ status, json: {} }));
    await assert.rejects(gh.getFile('o/r', 'a.md'), (e) => e instanceof AuthError && e.status === status && !e.message.includes(TOKEN) && e.message.includes(String(status)), `${status}는 AuthError`);
  }
  const { gh } = client(() => ({ status: 409, json: {} }));
  await assert.rejects(gh.putFile('o/r', 'posts/a.md', { text: 'x', sha: 'old', message: 'm' }), (e) => e instanceof ConflictError && e.path === 'posts/a.md', '409는 ConflictError(path)');
  const s500 = client(() => ({ status: 500, json: {} }));
  await assert.rejects(s500.gh.getRepo('o/r'), (e) => e instanceof GitHubError && !(e instanceof AuthError) && e.status === 500 && e.message.includes('/repos/o/r'), '500은 GitHubError, 경로 포함');
});

test('네트워크 실패는 status 0 GitHubError', async () => {
  const gh = createGitHub({ token: TOKEN, fetch: async () => { throw new TypeError('boom'); } });
  await assert.rejects(gh.getRepo('o/r'), (e) => e instanceof GitHubError && e.status === 0 && !e.message.includes(TOKEN), 'status 0');
});

test('putFile: sha 없이 기존 파일에 PUT한 422는 ConflictError, 본문 구성', async () => {
  const ok = client(() => ({ json: { content: { sha: 'n1' } } }));
  const r = await ok.gh.putFile('o/r', 'posts/a.md', { text: '한', message: 'm' });
  assert.deepEqual(r, { sha: 'n1' }, '새 sha');
  assert.equal(ok.calls[0].method, 'PUT', 'PUT');
  assert.deepEqual(ok.calls[0].body, { message: 'm', content: utf8ToBase64('한') }, 'sha 없으면 body에도 없음');
  const bad = client(() => ({ status: 422, json: {} }));
  await assert.rejects(bad.gh.putFile('o/r', 'posts/a.md', { base64: 'QQ==', message: 'm' }), (e) => e instanceof ConflictError && e.path === 'posts/a.md', '422는 ConflictError');
});

test('deleteFile 본문, getRepo, lastCommitDate, getBlobBase64', async () => {
  const d = client(() => ({ json: {} }));
  await d.gh.deleteFile('o/r', 'a.md', 's', 'm');
  assert.deepEqual([d.calls[0].method, d.calls[0].body], ['DELETE', { message: 'm', sha: 's' }], 'DELETE 본문');

  const repo = client(() => ({ json: { private: true, default_branch: 'main', permissions: { push: false } } }));
  assert.deepEqual(await repo.gh.getRepo('o/r'), { private: true, push: false, defaultBranch: 'main' }, '필드 매핑');

  const c = client(() => ({ json: [{ commit: { committer: { date: '2026-01-02T00:00:00Z' } } }] }));
  assert.equal(await c.gh.lastCommitDate('o/r', 'posts/a b.md'), '2026-01-02T00:00:00Z', '날짜');
  assert.ok(c.calls[0].url.includes('path=posts%2Fa%20b.md') && c.calls[0].url.includes('per_page=1'), '쿼리 인코딩');
  const none = client(() => ({ json: [] }));
  assert.equal(await none.gh.lastCommitDate('o/r', 'x'), null, '빈 배열은 null');

  const b = client(() => ({ json: { content: 'QU\nJD', encoding: 'base64' } }));
  assert.equal(await b.gh.getBlobBase64('o/r', 'sha1'), 'QUJD', '줄바꿈 제거한 base64');
});

test('listTree: 기본 브랜치 조회, 빈 저장소 409는 []', async () => {
  const { gh, calls } = client((req) => req.url.endsWith('/repos/o/r')
    ? { json: { private: false, default_branch: 'trunk', permissions: { push: true } } }
    : { json: { tree: [{ path: 'a', sha: '1', type: 'blob' }] } });
  assert.deepEqual(await gh.listTree('o/r'), [{ path: 'a', sha: '1', type: 'blob' }], '트리 항목');
  assert.ok(calls[1].url.endsWith('/git/trees/trunk?recursive=1'), '기본 브랜치 사용');
  await gh.listTree('o/r');
  assert.equal(calls.filter((c) => c.url.endsWith('/repos/o/r')).length, 1, '기본 브랜치는 한 번만 조회');

  const empty = client((req) => req.url.endsWith('/repos/o/r')
    ? { json: { default_branch: 'main', permissions: {} } }
    : { status: 409, json: { message: 'Git Repository is empty.' } });
  assert.deepEqual(await empty.gh.listTree('o/r'), [], '빈 저장소');
});

/** commitFiles용 서버 흉내. patch422Times번 ref PATCH를 422로 거절하고 그때마다 head를 옮긴다. */
function commitServer({ treeEntries, patch422Times = 0 }) {
  let patches = 0;
  let head = 'c0';
  return (req) => {
    const u = req.url.replace('https://api.github.com', '');
    if (u === '/repos/o/r') return { json: { default_branch: 'main', permissions: { push: true } } };
    if (u === '/repos/o/r/git/ref/heads/main') return { json: { object: { sha: head } } };
    if (u === `/repos/o/r/git/commits/${head}`) return { json: { tree: { sha: `t-${head}` } } };
    if (u === `/repos/o/r/git/trees/t-${head}?recursive=1`) return { json: { tree: treeEntries } };
    if (u === '/repos/o/r/git/blobs') return { json: { sha: `b-${req.body.content}` } };
    if (u === '/repos/o/r/git/trees') return { json: { sha: 'newtree' } };
    if (u === '/repos/o/r/git/commits') return { json: { sha: 'newcommit' } };
    if (u === '/repos/o/r/git/refs/heads/main') {
      patches += 1;
      if (patches <= patch422Times) { head = `c${patches}`; return { status: 422, json: {} }; }
      return { json: {} };
    }
    return { status: 500, json: { message: `unexpected ${u}` } };
  };
}

test('commitFiles: expect 불일치는 blob 만들기 전에 ConflictError', async () => {
  const { gh, calls } = client(commitServer({ treeEntries: [{ path: 'posts/a.md', sha: 'new', type: 'blob' }] }));
  await assert.rejects(
    gh.commitFiles('o/r', { message: 'm', files: [{ path: 'posts/a.md', base64: 'QQ==' }], deletes: [], expect: { 'posts/a.md': 'old' } }),
    (e) => e instanceof ConflictError && e.path === 'posts/a.md', 'sha가 다르면 ConflictError');
  assert.equal(calls.some((c) => c.url.endsWith('/git/blobs')), false, 'blob 생성 전에 멈춤');
  const absent = client(commitServer({ treeEntries: [{ path: 'posts/a.md', sha: 'x', type: 'blob' }] }));
  await assert.rejects(
    absent.gh.commitFiles('o/r', { message: 'm', files: [], deletes: [], expect: { 'posts/a.md': null } }),
    (e) => e instanceof ConflictError, 'null은 없어야 함');
});

test('commitFiles: 한 커밋, 삭제는 sha null, 422면 새 ref 기준으로 다시', async () => {
  const { gh, calls } = client(commitServer({ treeEntries: [{ path: 'posts/a.md', sha: 'old', type: 'blob' }], patch422Times: 1 }));
  const r = await gh.commitFiles('o/r', {
    message: 'm', files: [{ path: 'posts/a.md', base64: 'QQ==' }], deletes: ['posts/gone.md'], expect: { 'posts/a.md': 'old' },
  });
  assert.deepEqual(r, { commitSha: 'newcommit' }, '커밋 sha');
  const trees = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/trees'));
  assert.equal(trees.length, 2, '재시도마다 tree를 다시 만든다');
  assert.equal(trees[0].body.base_tree, 't-c0', '첫 시도는 처음 ref 기준');
  assert.equal(trees[1].body.base_tree, 't-c1', '재시도는 새 ref 기준');
  assert.deepEqual(trees[1].body.tree, [
    { path: 'posts/a.md', mode: '100644', type: 'blob', sha: 'b-QQ==' },
    { path: 'posts/gone.md', mode: '100644', type: 'blob', sha: null },
  ], '파일과 삭제 항목');
  const commits = calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
  assert.deepEqual(commits[1].body.parents, ['c1'], '부모는 새 ref');
});

test('commitFiles: ref 422가 계속되면 첫 시도 + 다시 3번 뒤 포기', async () => {
  const { gh, calls } = client(commitServer({ treeEntries: [], patch422Times: 99 }));
  await assert.rejects(
    gh.commitFiles('o/r', { message: 'm', files: [{ path: 'a', base64: 'QQ==' }], deletes: [], expect: {} }),
    (e) => e instanceof GitHubError && e.status === 422, '422 오류로 끝남');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 4, '첫 시도 1 + 다시 3 = 4번');
});

test('commitFiles: tree 단계 422는 재시도 없이 바로 실패', async () => {
  const base = commitServer({ treeEntries: [] });
  const { gh, calls } = client((req) => (req.method === 'POST' && req.url.endsWith('/git/trees') ? { status: 422, json: {} } : base(req)));
  await assert.rejects(
    gh.commitFiles('o/r', { message: 'm', files: [{ path: 'a', base64: 'QQ==' }], deletes: [], expect: {} }),
    (e) => e instanceof GitHubError && e.status === 422, '422 오류');
  assert.equal(calls.filter((c) => c.url.endsWith('/git/trees') && c.method === 'POST').length, 1, 'tree 요청은 한 번뿐');
});

test('모든 요청은 브라우저 HTTP 캐시를 쓰지 않는다', async () => {
  const inits = [];
  const gh = createGitHub({ token: TOKEN, fetch: async (url, init) => { inits.push(init); return new Response('{"private":false,"default_branch":"main","permissions":{}}'); } });
  await gh.getRepo('o/r');
  assert.equal(inits[0].cache, 'no-store', 'cache: no-store');
});
