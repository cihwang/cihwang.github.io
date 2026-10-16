import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost, serializePost, slugFromTitle, postPath, validateDraft, validatePublish, validateCategoryName, recategorize } from '../editor/post.js';

const text = '---\r\ntitle: Agentforce Coworker 소개\r\ncategory: 공부\r\ndate: 2026-10-13\r\ndraft: true\r\nextra: 1\r\n---\r\n## 가 😀\r\n';

test('머리말 읽기·쓰기', () => {
  const { meta, body } = parsePost(text);
  assert.equal(body, '## 가 😀\n', 'CRLF는 LF로');
  assert.equal(serializePost(meta, body),
    '---\ntitle: Agentforce Coworker 소개\ncategory: 공부\ndate: 2026-10-13\ndraft: true\nextra: 1\n---\n## 가 😀\n',
    '알려진 키 순서 + 모르는 키 보존 + LF');
  assert.deepEqual(parsePost(serializePost(meta, body)), { meta, body }, '왕복해도 같다');
});

test('slug와 경로', () => {
  assert.equal(slugFromTitle('Agentforce Coworker 소개'), 'agentforce-coworker-소개', '한글 유지');
  assert.equal(slugFromTitle(' ?#/ '), 'post', '쓸 글자가 없으면 post');
  assert.equal(postPath('2026-10-16', 'a-b'), 'posts/2026-10-16-a-b.md', '파일 규칙');
});

test('초안·공개 검사', () => {
  assert.deepEqual(validateDraft({ title: '', category: '없음' }, ['글', '공부']).length, 2, '제목·카테고리 둘 다 오류');
  const live = [{ path: 'posts/x.md', cat: '공부', slug: 'a' }];
  assert.ok(validatePublish({ title: 't', category: '공부', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부'], livePosts: live, ownPath: null }).errors.length === 1, '같은 카테고리 slug 겹침');
  assert.equal(validatePublish({ title: 't', category: '공부', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부'], livePosts: live, ownPath: 'posts/x.md' }).errors.length, 0, '자기 자신과는 겹침이 아니다');
  assert.equal(validatePublish({ title: 't', category: '공부', date: '2026/10/16', slug: 'b' }, '![](../media/a.png)', { categories: ['공부'], livePosts: [], ownPath: null }).warnings.length, 1, '빈 설명 그림 경고');
});

test('카테고리 이름 검사', () => {
  assert.deepEqual(validateCategoryName('  일기 ', ['글']), [], '앞뒤 공백은 떼고 통과');
  for (const bad of ['', 'a/b', '#x', '_비밀', '가'.repeat(21), '글']) assert.ok(validateCategoryName(bad, ['글']).length > 0, `거부해야 함: "${bad}"`);
});

test('카테고리 바꾸기는 머리말 한 줄만 고친다', () => {
  const crlf = '---\r\ntitle: t\r\ncategory: 공부\r\n---\r\n본문 category: 공부\r\n';
  assert.equal(recategorize(crlf, '공부', '배움'), '---\r\ntitle: t\r\ncategory: 배움\r\n---\r\n본문 category: 공부\r\n', '머리말 한 줄만, 줄바꿈·본문 그대로');
  assert.equal(recategorize(crlf, '글', '배움'), null, '다른 카테고리 글은 건드리지 않는다');
});
