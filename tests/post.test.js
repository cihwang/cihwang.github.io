import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost, serializePost, slugFromTitle, postPath, validateDraft, validatePublish, validateCategoryName, recategorize, replaceFrontValue, isPostPath } from '../editor/post.js';

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

test('replaceFrontValue: 머리말의 그 키 값이 from일 때만 그 줄의 값만 바꾼다', () => {
  const crlf = '---\r\ntitle: t\r\nbase_sha: old\r\n---\r\nbase_sha: old\r\n';
  assert.equal(replaceFrontValue(crlf, 'base_sha', 'old', 'new'), '---\r\ntitle: t\r\nbase_sha: new\r\n---\r\nbase_sha: old\r\n', '머리말 한 줄만, 줄바꿈·본문 그대로');
  assert.equal(replaceFrontValue(crlf, 'base_sha', 'other', 'new'), null, '값이 from이 아니면 바꾸지 않는다');
  assert.equal(replaceFrontValue('---\ntitle: t\n---\nbase_sha: old\n', 'base_sha', 'old', 'new'), null, '본문에만 있는 줄은 머리말이 아니다');
});

test('카테고리 이름 검사: 따옴표는 쓸 수 없다(카테고리 바꾸기 뒤 머리말에서 벗겨져 빌드가 깨진다)', () => {
  for (const bad of ['"인용"', "작은'따옴표", '가"나']) assert.ok(validateCategoryName(bad, ['글']).length > 0, `거부해야 함: ${bad}`);
});

test('공개 검사: 공개된 글의 카테고리를 바꾸면 막지 않고 경고', () => {
  const live = [{ path: 'posts/x.md', cat: '공부', slug: 'a' }];
  const { errors, warnings } = validatePublish({ title: 't', category: '글', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부', '글'], livePosts: live, ownPath: 'posts/x.md' });
  assert.deepEqual(errors, [], '카테고리 변경은 오류가 아니다');
  assert.ok(warnings.some((w) => w.includes('카테고리')), '기존 링크가 끊긴다고 경고한다');
  const same = validatePublish({ title: 't', category: '공부', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부'], livePosts: live, ownPath: 'posts/x.md' });
  assert.deepEqual(same.warnings, [], '카테고리·slug가 그대로면 경고 없음');
  const fresh = validatePublish({ title: 't', category: '글', date: '2026-10-16', slug: 'b' }, '', { categories: ['글'], livePosts: live, ownPath: null });
  assert.deepEqual(fresh.warnings, [], '새 글은 끊길 링크가 없다');
});

test('편집 주소의 글 경로 검사', () => {
  for (const ok of ['posts/2026-10-16-a.md', 'posts/예시/글-01.md']) assert.equal(isPostPath(ok), true, `받아야 함: ${ok}`);
  for (const bad of ['', 'posts/', 'site.json', 'posts/a.txt', 'media/a.md', 'posts/../site.md', 'posts/a/../../b.md', 'posts\\a.md', 'posts/a\\..\\b.md', '/posts/a.md', 'posts/..'])
    assert.equal(isPostPath(bad), false, `거부해야 함: ${bad}`);
});
