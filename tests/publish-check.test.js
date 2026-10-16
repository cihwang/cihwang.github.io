import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublish } from '../editor/publish-check.js';
import { hasUploadPlaceholder, removeUploadPlaceholders } from '../editor/photo-upload.js';

const meta = { title: '연습', category: '공부', date: '2026-10-16', slug: 'a' };
const base = { categories: ['글', '공부'], livePosts: [], ownPath: null, uploading: 0 };

test('출간 검사: 통과와 칸별 오류', () => {
  assert.equal(checkPublish(meta, '본문', base).ok, true, '모두 맞으면 출간할 수 있다');
  const live = [{ path: 'posts/x.md', cat: '공부', slug: 'a' }];
  const clash = checkPublish(meta, '', { ...base, livePosts: live });
  assert.equal(clash.ok, false, '같은 카테고리·slug는 막는다');
  assert.equal(clash.fields.slug.length, 1, '겹침 문구에 "카테고리"가 들어 있어도 주소 칸 오류다');
  assert.equal(clash.fields.category.length, 0, '겹침은 카테고리 칸 오류가 아니다');
  const bad = checkPublish({ ...meta, title: '', category: '없음', date: '' }, '', base);
  assert.equal(bad.top.length, 1, '제목 오류는 칸이 없어 위에 보인다');
  assert.equal(bad.fields.category.length, 1, '목록에 없는 카테고리는 카테고리 칸');
  assert.equal(bad.fields.date.length, 1, '빈 날짜는 날짜 칸');
});

test('출간 검사: 주소 글자, 올리는 중 사진, 못 받은 목록', () => {
  assert.equal(checkPublish({ ...meta, slug: 'a/b' }, '', base).fields.slug.length, 1, '/ 는 경로를 깨뜨려 막는다');
  assert.equal(checkPublish({ ...meta, slug: 'a b' }, '', base).ok, false, '공백도 막는다');
  assert.equal(checkPublish(meta, '', { ...base, uploading: 1 }).ok, false, '올리는 중인 사진이 있으면 막는다');
  assert.equal(checkPublish(meta, '![올리는 중…](uploading-ab12cd34)\n', base).ok, false, '남은 자리표시가 있으면 막는다');
  assert.equal(checkPublish(meta, '', { ...base, livePosts: null }).ok, false, '사이트 글 목록이 없으면 겹침을 몰라 막는다');
  const warned = checkPublish(meta, '![](../media/a.png)', base);
  assert.equal(warned.ok, true, '빈 설명 그림은 출간을 막지 않는다');
  assert.equal(warned.warnings.length, 1, '빈 설명 그림은 경고로 알린다');
});

test('자리표시 줄 지우기', () => {
  const body = '위\n![올리는 중…](uploading-ab12cd34)\n![](../media/x.png)\n![올리는 중…](uploading-ef56ab78)';
  assert.equal(hasUploadPlaceholder(body), true, '자리표시가 있다');
  const { body: cleaned, count } = removeUploadPlaceholders(body);
  assert.equal(count, 2, '두 줄 모두 찾는다(마지막 줄은 줄바꿈 없이 끝나도)');
  assert.equal(cleaned, '위\n![](../media/x.png)\n', '자리표시 줄만 지우고 올라간 그림 줄은 남긴다');
  assert.deepEqual(removeUploadPlaceholders('그대로'), { body: '그대로', count: 0 }, '없으면 본문 그대로');
});
