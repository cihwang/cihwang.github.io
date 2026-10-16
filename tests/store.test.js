import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../editor/store.js';
import { createLocal } from '../editor/local.js';
import { GitHubError, AuthError, ConflictError, utf8ToBase64, base64ToUtf8 } from '../editor/github.js';
import { parsePost, serializePost } from '../editor/post.js';

const BLOG = 'cihwang/cihwang.github.io';
const DRAFTS = 'cihwang/blog-drafts';
const SITE_TEXT = '{\n  "site": "[이름]",\n  "categories": ["글", "공부", "만든 것", "취향"]\n}\n';

/**
 * editor/github.js 클라이언트와 같은 모양의 메모리 가짜.
 * 저장소마다 경로 → { base64, sha, updated } 맵을 두고, 모든 호출을 `calls`에 남긴다.
 * `fail(method, error, repo?)`로 그 메서드가 던지게 하고 `heal()`로 되돌린다.
 */
function fakeGitHub(initial) {
  let seq = 0;
  const nextSha = () => `sha-${(seq += 1)}`;
  const repos = new Map();
  for (const [repo, files] of Object.entries(initial)) {
    const map = new Map();
    for (const [path, value] of Object.entries(files)) {
      const v = typeof value === 'string' ? { text: value } : value;
      map.set(path, { base64: v.base64 ?? utf8ToBase64(v.text), sha: nextSha(), updated: v.updated ?? null });
    }
    repos.set(repo, map);
  }
  const calls = [];
  const commits = [];
  let failures = [];

  const files = (repo) => {
    if (!repos.has(repo)) repos.set(repo, new Map());
    return repos.get(repo);
  };
  function record(method, repo, args) {
    calls.push({ method, repo, args });
    const f = failures.find((x) => x.method === method && (!x.repo || x.repo === repo));
    if (f) throw f.error;
  }

  const gh = {
    async getFile(repo, path) {
      record('getFile', repo, { path });
      const f = files(repo).get(path);
      return f ? { text: base64ToUtf8(f.base64), sha: f.sha } : null;
    },
    async putFile(repo, path, { text, base64, sha, message }) {
      record('putFile', repo, { path, text, base64, sha, message });
      const cur = files(repo).get(path);
      if (cur ? sha !== cur.sha : sha) throw new ConflictError(409, `충돌 (${path})`, path);
      const next = { base64: base64 ?? utf8ToBase64(text), sha: nextSha(), updated: '2026-10-16T09:00:00Z' };
      files(repo).set(path, next);
      return { sha: next.sha };
    },
    async deleteFile(repo, path, sha, message) {
      record('deleteFile', repo, { path, sha, message });
      const cur = files(repo).get(path);
      if (!cur) return;
      if (cur.sha !== sha) throw new GitHubError(409, `sha 다름 (${path})`);
      files(repo).delete(path);
    },
    async listTree(repo) {
      record('listTree', repo, {});
      const out = [];
      const dirs = new Set();
      for (const [path, f] of files(repo)) {
        out.push({ path, sha: f.sha, type: 'blob' });
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
      }
      for (const d of dirs) out.push({ path: d, sha: `tree-${d}`, type: 'tree' });
      return out;
    },
    async lastCommitDate(repo, path) {
      record('lastCommitDate', repo, { path });
      return files(repo).get(path)?.updated ?? null;
    },
    async getBlobBase64(repo, sha) {
      record('getBlobBase64', repo, { sha });
      for (const f of files(repo).values()) if (f.sha === sha) return f.base64;
      throw new GitHubError(404, `blob 없음 (${sha})`);
    },
    async commitFiles(repo, change) {
      record('commitFiles', repo, change);
      for (const [path, sha] of Object.entries(change.expect)) {
        if ((files(repo).get(path)?.sha ?? null) !== sha) throw new ConflictError(409, `충돌 (${path})`, path);
      }
      for (const { path, base64 } of change.files) files(repo).set(path, { base64, sha: nextSha(), updated: '2026-10-16T10:00:00Z' });
      for (const path of change.deletes) files(repo).delete(path);
      commits.push({ repo, ...change });
      return { commitSha: `commit-${commits.length}` };
    },
  };

  return {
    gh,
    calls,
    commits,
    text: (repo, path) => (files(repo).has(path) ? base64ToUtf8(files(repo).get(path).base64) : null),
    sha: (repo, path) => files(repo).get(path)?.sha ?? null,
    has: (repo, path) => files(repo).has(path),
    /** 다른 기기가 같은 파일을 저장한 것처럼 내용과 sha를 바꾼다. */
    overwrite(repo, path, text) {
      files(repo).set(path, { base64: utf8ToBase64(text), sha: nextSha(), updated: '2026-10-16T11:00:00Z' });
    },
    fail(method, error, repo) { failures.push({ method, error, repo }); },
    heal() { failures = []; },
    reset() { calls.length = 0; },
  };
}

const post = (meta, body = '본문\n') => serializePost(meta, body);

const LIVE = [
  { path: 'posts/예시/공부-01.md', cat: '공부', slug: '공부-01', title: '공부 01' },
  { path: 'posts/예시/글-01.md', cat: '글', slug: '글-01', title: '글 01' },
];

function standardFake() {
  return fakeGitHub({
    [BLOG]: {
      'site.json': SITE_TEXT,
      'posts/예시/공부-01.md': post({ title: '공부 01', category: '공부', date: '2026-01-05' }),
      'posts/예시/글-01.md': post({ title: '글 01', category: '글', date: '2026-01-06' }),
      'posts/2026-10-13-agentforce-coworker.md': { text: post({ title: 'Agentforce Coworker 소개', category: '취향', date: '2026-10-13', draft: 'true' }), updated: '2026-10-13T08:00:00Z' },
      'posts/2026-10-01-pushed.md': post({ title: '방금 올린 글', category: '글', date: '2026-10-01' }),
      'posts/_템플릿.md': post({ title: '템플릿', category: '글', draft: 'true' }),
      'media/old.png': { base64: 'b2xk' },
    },
    [DRAFTS]: {
      'posts/2026-10-16-a.md': { text: post({ title: 'A', category: '공부', date: '2026-10-16', draft: 'true' }), updated: '2026-10-16T07:00:00Z' },
      'posts/예시/공부-01.md': { text: post({ title: '공부 01 고침', category: '공부', date: '2026-01-05', draft: 'true' }), updated: '2026-10-15T07:00:00Z' },
      'posts/_템플릿.md': post({ title: '템플릿', category: '글', draft: 'true' }),
      'posts/_보관/옛글.md': post({ title: '옛글', category: '글', draft: 'true' }),
      'posts/2026-10-02-undated.md': post({ title: '날짜 모름', category: '글', draft: 'true' }),
      'media/new.png': { base64: 'bmV3' },
      'media/old.png': { base64: 'b2xk' },
    },
  });
}

async function storeWithSite(fake, extra = {}) {
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS, today: () => '2026-10-16', ...extra });
  await store.getSite();
  fake.reset();
  return store;
}

test('listDrafts: 초안은 new/editing, 블로그의 draft 글은 public-draft, _ 이름은 빠지고 최근 수정순', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS, today: () => '2026-10-16' });
  const list = await store.listDrafts(LIVE);
  const byPath = Object.fromEntries(list.map((e) => [`${e.repo}:${e.path}`, e]));

  assert.deepEqual(byPath['drafts:posts/2026-10-16-a.md'], {
    repo: 'drafts', path: 'posts/2026-10-16-a.md', title: 'A', category: '공부', updated: '2026-10-16T07:00:00Z', kind: 'new',
  }, '라이브에 없는 초안은 new이고 머리말에서 제목·카테고리를 읽는다');
  assert.equal(byPath['drafts:posts/예시/공부-01.md']?.kind, 'editing', '라이브에 같은 경로가 있는 초안은 고치는 중');
  assert.deepEqual(byPath['blog:posts/2026-10-13-agentforce-coworker.md'], {
    repo: 'blog', path: 'posts/2026-10-13-agentforce-coworker.md', title: 'Agentforce Coworker 소개', category: '취향', updated: '2026-10-13T08:00:00Z', kind: 'public-draft',
  }, '블로그에만 있고 라이브에 없는 draft: true 글은 public-draft');
  assert.ok(!list.some((e) => e.path.split('/').some((s) => s.startsWith('_'))), '_로 시작하는 파일·폴더는 목록에 없다');
  assert.ok(!byPath['blog:posts/2026-10-01-pushed.md'], 'draft가 아닌 블로그 글은 라이브 반영 전이라도 임시글이 아니다');
  assert.ok(!byPath['blog:posts/예시/공부-01.md'], '라이브 글은 블로그 쪽 임시글로 나오지 않는다');
  assert.equal(list.length, 4, '초안 3편 + 공개 저장소 임시글 1편');
  assert.deepEqual(list.map((e) => e.updated), ['2026-10-16T07:00:00Z', '2026-10-15T07:00:00Z', '2026-10-13T08:00:00Z', null], '최근 수정순, 날짜 모름은 맨 뒤');
});

test('open: 블로그 경로를 열면 초안 저장소의 같은 경로 내용을 열고 blogSha만 블로그에서 채운다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS });
  const doc = await store.open({ repo: 'blog', path: 'posts/예시/공부-01.md' });
  assert.equal(doc.meta.title, '공부 01 고침', '초안 저장소의 고치던 내용을 연다');
  assert.equal(doc.draftPath, 'posts/예시/공부-01.md', '초안 경로');
  assert.equal(doc.draftSha, fake.sha(DRAFTS, 'posts/예시/공부-01.md'), '초안 sha');
  assert.equal(doc.blogPath, 'posts/예시/공부-01.md', '공개된 글을 고치는 중');
  assert.equal(doc.blogSha, fake.sha(BLOG, 'posts/예시/공부-01.md'), 'blogSha는 블로그 쪽 sha');

  const plain = await store.open({ repo: 'blog', path: 'posts/예시/글-01.md' });
  assert.equal(plain.meta.title, '글 01', '초안이 없으면 블로그 원본을 연다');
  assert.equal(plain.draftPath, null, '초안 경로 없음');
  assert.equal(plain.draftSha, null, '초안 sha 없음');

  const fresh = await store.open({ repo: 'drafts', path: 'posts/2026-10-16-a.md' });
  assert.equal(fresh.blogPath, null, '블로그에 없는 초안은 새 글');
  assert.equal(fresh.blogSha, null, '새 글은 blogSha 없음');
  await assert.rejects(store.open({ repo: 'drafts', path: 'posts/없음.md' }), /없음\.md/, '없는 글은 경로를 담아 오류');
});

test('newDoc: 오늘 날짜와 draft 표시가 붙은 빈 글', () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS, today: () => '2026-10-16' });
  assert.deepEqual(store.newDoc('글'), {
    meta: { title: '', category: '글', date: '2026-10-16', draft: 'true' }, body: '',
    draftPath: null, draftSha: null, blogPath: null, blogSha: null,
  }, 'Doc 모양 그대로, 경로·sha는 null');
});

test('today 기본값은 기기 지역 날짜 YYYY-MM-DD', () => {
  const store = createStore({ gh: standardFake().gh, draftsRepo: DRAFTS });
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(store.newDoc('글').meta.date, expected, '기기 시간 기준 오늘');
});

test('saveDraft: 제목이 없으면 오류이고 GitHub 호출이 없다', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  await assert.rejects(store.saveDraft(store.newDoc('글')), /제목을 입력해 주세요/, '무엇을 채울지 오류 목록에 담는다');
  assert.equal(fake.calls.length, 0, '검사에 걸리면 GitHub를 부르지 않는다');
});

test('saveDraft: 두 번째 저장은 첫 저장의 sha를 쓰고, 그 사이 다른 기기가 저장했으면 ConflictError로 덮지 않는다', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const doc = { ...store.newDoc('글'), meta: { title: '새 글 하나', category: '글', date: '2026-10-16', draft: 'true' }, body: '첫 줄\n' };
  const first = await store.saveDraft(doc);
  const path = 'posts/2026-10-16-새-글-하나.md';
  assert.equal(first.draftPath, path, '경로는 날짜 + 제목에서 만든 slug');
  assert.equal(fake.calls[0].args.sha, undefined, '새 파일은 sha 없이 올린다');
  assert.equal(fake.calls[0].args.message, '초안: 새 글 하나', '초안 저장 메시지');
  assert.equal(first.draftSha, fake.sha(DRAFTS, path), '새 draftSha를 돌려준다');
  assert.equal(parsePost(fake.text(DRAFTS, path)).meta.draft, 'true', '초안에는 draft: true가 붙는다');

  fake.reset();
  const second = await store.saveDraft({ ...first, body: '둘째 줄\n' });
  assert.equal(fake.calls[0].args.sha, first.draftSha, '두 번째 저장은 첫 저장이 돌려준 sha로');
  assert.notEqual(second.draftSha, first.draftSha, 'sha가 새로 바뀐다');

  fake.overwrite(DRAFTS, path, post({ title: '새 글 하나', category: '글', draft: 'true' }, '다른 기기\n'));
  await assert.rejects(store.saveDraft({ ...second, body: '셋째 줄\n' }), ConflictError, '다른 기기의 저장과 부딪히면 ConflictError');
  assert.equal(parsePost(fake.text(DRAFTS, path)).body, '다른 기기\n', '다른 기기 내용을 덮어쓰지 않는다');
});

test('saveDraft: 공개된 글을 고치면 초안 저장소의 같은 경로에 저장하고 블로그는 그대로', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const before = fake.text(BLOG, 'posts/예시/글-01.md');
  const doc = await store.open({ repo: 'blog', path: 'posts/예시/글-01.md' });
  const saved = await store.saveDraft({ ...doc, body: '고친 본문\n' });
  assert.equal(saved.draftPath, 'posts/예시/글-01.md', '블로그 경로와 같은 초안 경로');
  assert.equal(saved.blogPath, 'posts/예시/글-01.md', 'blogPath는 유지');
  assert.equal(parsePost(fake.text(DRAFTS, 'posts/예시/글-01.md')).body, '고친 본문\n', '초안 저장소에 고친 내용');
  assert.equal(fake.text(BLOG, 'posts/예시/글-01.md'), before, '공개본은 수정하기 전까지 그대로');
});

test('인증 오류: saveDraft는 AuthError를 그대로 던지고 기기 저장본은 남는다', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const memory = new Map();
  const storage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
    key: (i) => [...memory.keys()][i] ?? null,
    get length() { return memory.size; },
  };
  const local = createLocal(storage);
  const doc = { ...store.newDoc('글'), meta: { title: '토큰 만료', category: '글', date: '2026-10-16', draft: 'true' }, body: '잃으면 안 되는 글\n' };
  const data = { ...doc, savedAt: '2026-10-16T09:00:00Z', remoteSavedAt: null };
  local.save('new:abc', data);

  fake.fail('putFile', new AuthError(401, '토큰 만료'));
  await assert.rejects(store.saveDraft(doc), AuthError, 'AuthError가 바뀌지 않고 올라온다');
  assert.deepEqual(local.load('new:abc'), data, '기기 저장본은 그대로 남아 되살릴 수 있다');
});

function publishFake() {
  const fake = standardFake();
  fake.overwrite(DRAFTS, 'posts/2026-10-16-hello.md', post(
    { title: '안녕', category: '글', date: '2026-10-16', slug: 'hello', draft: 'true' },
    '![새 사진](../media/new.png)\n![옛 사진](../media/old.png)\n',
  ));
  return fake;
}

test('publish(새 글): 블로그에 커밋 1번, 글 + 초안에만 있던 사진, draft 줄 없음, expect는 null, 그다음 초안 삭제', async () => {
  const fake = publishFake();
  const store = await storeWithSite(fake);
  const doc = await store.open({ repo: 'drafts', path: 'posts/2026-10-16-hello.md' });
  const result = await store.publish(doc, LIVE);

  assert.deepEqual(result, { path: 'posts/2026-10-16-hello.md', alreadyPublished: false }, '대상 경로와 새 출간');
  assert.equal(fake.commits.length, 1, '블로그에 커밋 1번');
  const [commit] = fake.commits;
  assert.equal(commit.repo, BLOG, '블로그 저장소에 커밋');
  assert.equal(commit.message, '글: 안녕', '새 글 메시지');
  assert.deepEqual(commit.files.map((f) => f.path).sort(), ['media/new.png', 'posts/2026-10-16-hello.md'], '글 1개 + 초안에만 있던 사진 1개(블로그에 있는 사진은 빼고)');
  assert.equal(commit.files.find((f) => f.path === 'media/new.png').base64, 'bmV3', '사진은 초안 저장소 blob 그대로');
  const text = base64ToUtf8(commit.files.find((f) => f.path.endsWith('.md')).base64);
  assert.ok(!/^draft:/m.test(text), '출간본에는 draft 줄이 없다');
  assert.equal(parsePost(text).meta.title, '안녕', '출간본 머리말');
  assert.deepEqual(commit.deletes, [], '새 글은 지울 파일이 없다');
  assert.deepEqual(commit.expect, { 'posts/2026-10-16-hello.md': null }, '새 글은 대상이 없어야 한다');

  const commitAt = fake.calls.findIndex((c) => c.method === 'commitFiles');
  const deleteAt = fake.calls.findIndex((c) => c.method === 'deleteFile');
  assert.ok(deleteAt > commitAt, '초안 삭제는 블로그 커밋 뒤에만');
  assert.equal(fake.calls[deleteAt].repo, DRAFTS, '초안 저장소에서 지운다');
  assert.equal(fake.has(DRAFTS, 'posts/2026-10-16-hello.md'), false, '초안이 지워졌다');
});

test('publish(새 글): 검사 오류면 GitHub에 쓰지 않는다', async () => {
  const fake = publishFake();
  const store = await storeWithSite(fake);
  const doc = await store.open({ repo: 'drafts', path: 'posts/2026-10-16-hello.md' });
  const live = [...LIVE, { path: 'posts/2026-09-01-hello.md', cat: '글', slug: 'hello', title: '다른 글' }];
  await assert.rejects(store.publish(doc, live), /같은 주소/, '같은 카테고리에 같은 slug면 오류');
  assert.ok(!fake.calls.some((c) => ['commitFiles', 'putFile', 'deleteFile'].includes(c.method)), '쓰기 호출이 없다');
});

test('publish(공개된 글의 slug 변경): deletes에 옛 경로, expect는 옛 sha', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const old = 'posts/예시/글-01.md';
  const oldSha = fake.sha(BLOG, old);
  const doc = await store.open({ repo: 'blog', path: old });
  const result = await store.publish({ ...doc, meta: { ...doc.meta, slug: 'new-slug' } }, LIVE);

  assert.equal(result.path, 'posts/2026-01-06-new-slug.md', 'slug가 바뀌면 postPath(date, slug)로 옮긴다');
  const [commit] = fake.commits;
  assert.equal(commit.message, '수정: 글 01', '수정 메시지');
  assert.deepEqual(commit.deletes, [old], '옛 경로를 지운다');
  assert.equal(commit.expect[old], oldSha, 'expect는 옛 경로의 읽은 sha');
  assert.equal(commit.expect['posts/2026-01-06-new-slug.md'], null, '옮길 자리에 다른 글이 없어야 한다');
  assert.equal(fake.has(BLOG, old), false, '옛 경로가 사라졌다');
});

test('publish(공개된 글, slug·날짜 그대로): 같은 경로에 수정, 고치던 초안은 지운다', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const path = 'posts/예시/공부-01.md';
  const blogSha = fake.sha(BLOG, path);
  const doc = await store.open({ repo: 'blog', path });
  const result = await store.publish({ ...doc, meta: { ...doc.meta, slug: '공부-01' } }, LIVE);
  assert.deepEqual(result, { path, alreadyPublished: false }, '같은 경로');
  assert.deepEqual(fake.commits[0].deletes, [], '옮기지 않으면 지울 파일 없음');
  assert.deepEqual(fake.commits[0].expect, { [path]: blogSha }, 'expect는 읽은 블로그 sha');
  assert.equal(parsePost(fake.text(BLOG, path)).meta.title, '공부 01 고침', '고치던 내용이 공개본에 반영');
  assert.equal(fake.has(DRAFTS, path), false, '고치던 초안은 지워진다');
});

test('다시 출간: 커밋 뒤 초안 삭제가 실패했으면, 다시 눌러도 커밋은 더 생기지 않고 초안 삭제만 다시 한다', async () => {
  const fake = publishFake();
  const store = await storeWithSite(fake);
  const doc = await store.open({ repo: 'drafts', path: 'posts/2026-10-16-hello.md' });

  fake.fail('deleteFile', new GitHubError(0, '네트워크 끊김'));
  await assert.rejects(store.publish(doc, LIVE), /네트워크 끊김/, '초안 삭제 실패는 숨기지 않는다');
  assert.equal(fake.commits.length, 1, '커밋은 됐다');
  assert.equal(fake.has(DRAFTS, 'posts/2026-10-16-hello.md'), true, '초안은 남았다');

  fake.heal();
  fake.reset();
  const live = [...LIVE, { path: 'posts/2026-10-16-hello.md', cat: '글', slug: 'hello', title: '안녕' }];
  const again = await store.publish(doc, live);
  assert.deepEqual(again, { path: 'posts/2026-10-16-hello.md', alreadyPublished: true }, '이미 출간된 것으로 본다');
  assert.equal(fake.commits.length, 1, '커밋이 하나도 더 생기지 않는다');
  assert.equal(fake.calls.filter((c) => c.method === 'deleteFile').length, 1, '초안 삭제만 다시 시도');
  assert.equal(fake.has(DRAFTS, 'posts/2026-10-16-hello.md'), false, '이번엔 초안이 지워졌다');
});

test('다시 출간(slug 변경 뒤): 옛 경로가 이미 사라졌어도 새 경로 내용이 같으면 커밋하지 않는다', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const doc = await store.open({ repo: 'blog', path: 'posts/예시/공부-01.md' });
  const moved = { ...doc, meta: { ...doc.meta, slug: 'moved' } };
  fake.fail('deleteFile', new GitHubError(500, '서버 오류'));
  await assert.rejects(store.publish(moved, LIVE), /서버 오류/, '초안 삭제 실패');
  fake.heal();
  const again = await store.publish(moved, LIVE);
  assert.deepEqual(again, { path: 'posts/2026-01-05-moved.md', alreadyPublished: true }, '새 경로에 같은 내용이 있으면 출간된 것');
  assert.equal(fake.commits.length, 1, '커밋 1번뿐');
  assert.equal(fake.has(DRAFTS, 'posts/예시/공부-01.md'), false, '초안이 지워졌다');
});

test('publish: 다른 기기가 그 사이 공개본을 고쳤으면 ConflictError, 초안은 그대로', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const path = 'posts/예시/공부-01.md';
  const doc = await store.open({ repo: 'blog', path });
  fake.overwrite(BLOG, path, post({ title: '다른 기기 수정', category: '공부', date: '2026-01-05' }));
  await assert.rejects(store.publish({ ...doc, meta: { ...doc.meta, slug: '공부-01' } }, LIVE), ConflictError, '옛 blogSha로는 커밋하지 않는다');
  assert.equal(parsePost(fake.text(BLOG, path)).meta.title, '다른 기기 수정', '공개본을 덮지 않는다');
  assert.equal(fake.has(DRAFTS, path), true, '초안은 지우지 않는다');
});

test('uploadMedia: 초안 저장소에 media/ 이름으로 base64를 올린다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS, now: () => new Date(2026, 9, 16, 9, 5, 7) });
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const path = await store.uploadMedia(new Blob([bytes]), 'Photo.JPEG', 'x1y2');
  assert.equal(path, 'media/20261016-090507-x1y2.jpg', 'mediaFileName 규칙의 경로');
  const call = fake.calls.find((c) => c.method === 'putFile');
  assert.equal(call.repo, DRAFTS, '초안 저장소에 올린다');
  assert.equal(call.args.base64, btoa(String.fromCharCode(...bytes)), '바이트가 그대로 base64로');
  assert.equal(call.args.sha, undefined, '새 파일');
});

test('deleteDraft·deletePost: 초안은 sha로 지우고, 블로그 글은 한 커밋으로 지우되 사진은 남긴다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS });
  await store.deleteDraft('posts/2026-10-16-a.md', fake.sha(DRAFTS, 'posts/2026-10-16-a.md'));
  assert.equal(fake.has(DRAFTS, 'posts/2026-10-16-a.md'), false, '초안이 지워졌다');

  const path = 'posts/예시/글-01.md';
  const sha = fake.sha(BLOG, path);
  await store.deletePost(path);
  assert.equal(fake.commits.length, 1, '블로그는 커밋 1번');
  assert.equal(fake.commits[0].message, '삭제: 글 01', '삭제 메시지에 제목');
  assert.deepEqual(fake.commits[0].deletes, [path], '그 글만 지운다');
  assert.deepEqual(fake.commits[0].files, [], '올리는 파일 없음');
  assert.deepEqual(fake.commits[0].expect, { [path]: sha }, '읽은 sha 그대로일 때만');
  assert.equal(fake.has(BLOG, 'media/old.png'), true, '사진은 지우지 않는다');
});

test('moveToDrafts: 공개 저장소 임시글을 초안 저장소 같은 경로로 옮기고 블로그에서는 한 커밋으로 지운다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS });
  const path = 'posts/2026-10-13-agentforce-coworker.md';
  const text = fake.text(BLOG, path);
  const doc = await store.moveToDrafts(path);
  assert.equal(fake.text(DRAFTS, path), text, '초안 저장소에 같은 내용');
  assert.equal(fake.has(BLOG, path), false, '블로그에서 지워졌다');
  assert.equal(fake.commits.length, 1, '블로그 쪽은 한 커밋');
  assert.deepEqual(fake.commits[0].deletes, [path], '그 글만 지운다');
  assert.equal(doc.draftPath, path, '초안 경로로 연다');
  assert.equal(doc.draftSha, fake.sha(DRAFTS, path), '초안 sha');
  assert.equal(doc.blogPath, null, '이제 블로그에는 없다');
  assert.equal(doc.meta.title, 'Agentforce Coworker 소개', '머리말을 읽었다');
});

test('moveToDrafts: 초안 저장소 옮기기만 되고 블로그 커밋이 실패했으면 다시 해도 겹쳐 쓰지 않고 마저 지운다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS });
  const path = 'posts/2026-10-13-agentforce-coworker.md';
  fake.fail('commitFiles', new GitHubError(500, '서버 오류'));
  await assert.rejects(store.moveToDrafts(path), /서버 오류/, '블로그 커밋 실패');
  fake.heal();
  const doc = await store.moveToDrafts(path);
  assert.equal(fake.has(BLOG, path), false, '두 번째에 블로그에서 지웠다');
  assert.equal(doc.draftSha, fake.sha(DRAFTS, path), '이미 옮겨 둔 초안을 그대로 쓴다');
});

test('getSite·countByCategory: site.json을 읽고 라이브 글 수를 센다', async () => {
  const fake = standardFake();
  const store = createStore({ gh: fake.gh, draftsRepo: DRAFTS });
  const site = await store.getSite();
  assert.deepEqual(site, { site: '[이름]', categories: ['글', '공부', '만든 것', '취향'], sha: fake.sha(BLOG, 'site.json') }, 'site.json 내용과 sha');
  assert.deepEqual(store.countByCategory([...LIVE, { path: 'posts/x.md', cat: '공부' }]), { 공부: 2, 글: 1 }, '카테고리별 라이브 글 수');
});

test('addCategory: site.json 한 커밋, 배열 끝에 새 이름. 겹치면 GitHub 호출 없음', async () => {
  const fake = standardFake();
  const store = await storeWithSite(fake);
  const sha = fake.sha(BLOG, 'site.json');
  const categories = await store.addCategory(' 일기 ');
  assert.deepEqual(categories, ['글', '공부', '만든 것', '취향', '일기'], '끝에 앞뒤 공백을 뗀 이름');
  assert.equal(fake.commits.length, 1, '커밋 1번');
  const [commit] = fake.commits;
  assert.equal(commit.message, '카테고리 추가: 일기', '메시지');
  assert.deepEqual(commit.expect, { 'site.json': sha }, '읽은 sha 그대로일 때만');
  assert.deepEqual(commit.files.map((f) => f.path), ['site.json'], 'site.json만');
  assert.equal(base64ToUtf8(commit.files[0].base64), JSON.stringify({ site: '[이름]', categories }, null, 2) + '\n', '정해진 JSON 모양, sha는 넣지 않는다');

  const again = await storeWithSite(fake);
  await assert.rejects(again.addCategory('일기'), /이미 있는 카테고리/, '겹치는 이름은 오류');
  assert.equal(fake.calls.length, 0, '검사에 걸리면 GitHub를 부르지 않는다');
});

function renameFake() {
  return fakeGitHub({
    [BLOG]: {
      'site.json': SITE_TEXT,
      'posts/예시/공부-01.md': post({ title: '공부 01', category: '공부', date: '2026-01-05' }),
      'posts/예시/공부-02.md': '---\r\ntitle: 공부 02\r\ncategory: 공부\r\n---\r\n본문\r\n',
      'posts/예시/글-01.md': post({ title: '글 01', category: '글' }),
      'posts/_템플릿.md': post({ title: '템플릿', category: '공부' }),
    },
    [DRAFTS]: {
      'posts/2026-10-16-a.md': post({ title: 'A', category: '공부', draft: 'true' }),
      'posts/2026-10-16-b.md': post({ title: 'B', category: '글', draft: 'true' }),
    },
  });
}

test('renameCategory: 블로그 한 커밋(공부 글 2편 + site.json), 초안 저장소 한 커밋(공부 초안 1편)', async () => {
  const fake = renameFake();
  const store = await storeWithSite(fake);
  const shas = ['posts/예시/공부-01.md', 'posts/예시/공부-02.md', 'site.json'].map((p) => fake.sha(BLOG, p));
  const result = await store.renameCategory('공부', '배움');

  assert.deepEqual(result, { posts: 2, drafts: 1 }, '바꾼 글 수');
  assert.equal(fake.commits.length, 2, '블로그 1번 + 초안 1번');
  const [blog, drafts] = fake.commits;
  assert.equal(blog.repo, BLOG, '블로그가 먼저');
  assert.equal(blog.message, '카테고리 이름 바꾸기: 공부 → 배움', '메시지');
  assert.deepEqual(blog.files.map((f) => f.path).sort(), ['posts/예시/공부-01.md', 'posts/예시/공부-02.md', 'site.json'], '공부 글 2편과 site.json만(글 카테고리·_템플릿 제외)');
  assert.deepEqual(blog.expect, { 'posts/예시/공부-01.md': shas[0], 'posts/예시/공부-02.md': shas[1], 'site.json': shas[2] }, 'expect는 각 파일의 읽은 sha');
  assert.deepEqual(JSON.parse(fake.text(BLOG, 'site.json')).categories, ['글', '배움', '만든 것', '취향'], '순서는 그대로, 그 자리만 바뀐다');
  assert.equal(fake.text(BLOG, 'posts/예시/공부-02.md'), '---\r\ntitle: 공부 02\r\ncategory: 배움\r\n---\r\n본문\r\n', 'category 줄만 바뀌고 CRLF는 유지');
  assert.equal(drafts.repo, DRAFTS, '그다음 초안 저장소');
  assert.deepEqual(drafts.files.map((f) => f.path), ['posts/2026-10-16-a.md'], '공부 초안 1편');
  assert.equal(parsePost(fake.text(DRAFTS, 'posts/2026-10-16-b.md')).meta.category, '글', '다른 카테고리 초안은 그대로');
  assert.deepEqual((await store.getSite()).categories, ['글', '배움', '만든 것', '취향'], '바꾼 뒤 getSite는 새 목록');
});

test('renameCategory: 블로그 커밋이 ConflictError면 초안 저장소는 건드리지 않는다', async () => {
  const fake = renameFake();
  const store = await storeWithSite(fake);
  fake.fail('commitFiles', new ConflictError(409, '충돌', 'site.json'), BLOG);
  await assert.rejects(store.renameCategory('공부', '배움'), ConflictError, '충돌은 그대로 올린다');
  assert.equal(fake.calls.filter((c) => c.repo === DRAFTS).length, 0, '초안 저장소 호출 0번');
});

test('renameCategory: 초안 쪽만 실패하면 블로그는 바뀌고 초안 N편은 그대로라고 알린다', async () => {
  const fake = renameFake();
  const store = await storeWithSite(fake);
  const cause = new GitHubError(500, '서버 오류');
  fake.fail('commitFiles', cause, DRAFTS);
  await assert.rejects(store.renameCategory('공부', '배움'), (e) => {
    assert.match(e.message, /블로그는 바뀜/, '블로그가 바뀐 것을 알린다');
    assert.match(e.message, /초안 1편은 그대로/, '안 바뀐 초안 수를 알린다');
    assert.equal(e.cause, cause, '원래 오류를 cause로 남긴다');
    return true;
  }, '부분 실패는 성공이 아니라 오류');
  assert.equal(JSON.parse(fake.text(BLOG, 'site.json')).categories[1], '배움', '블로그는 바뀌었다');
});

test('renameCategory: 새 이름 규칙에 걸리거나 없는 카테고리면 GitHub 호출 없이 오류', async () => {
  const fake = renameFake();
  const store = await storeWithSite(fake);
  await assert.rejects(store.renameCategory('공부', '글'), /이미 있는 카테고리/, '이미 있는 이름으로는 못 바꾼다');
  await assert.rejects(store.renameCategory('없는것', '배움'), /없는것/, '없는 카테고리는 이름을 담아 오류');
  assert.equal(fake.calls.length, 0, 'GitHub 호출 없음');
});
