import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocal } from '../editor/local.js';
import { LOCAL_PREFIX } from '../editor/config.js';

/** localStorage와 같은 메서드를 가진 메모리 저장소. */
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

const DATA = {
  meta: { title: '한글 😀', category: '글', date: '2026-10-16', draft: 'true' },
  body: '첫 줄\r\n둘째 줄\n',
  draftPath: 'posts/2026-10-16-a.md', draftSha: 'sha-1', blogPath: null, blogSha: null,
  savedAt: '2026-10-16T09:00:00.000Z', remoteSavedAt: null,
};

test('createLocal: 저장·읽기·지우기, 키 앞에 LOCAL_PREFIX', () => {
  const storage = memoryStorage();
  const local = createLocal(storage);
  local.save('posts/2026-10-16-a.md', DATA);
  assert.ok(storage.map.has(LOCAL_PREFIX + 'posts/2026-10-16-a.md'), '저장 키에 접두어가 붙는다');
  assert.deepEqual(local.load('posts/2026-10-16-a.md'), DATA, '한글·이모지·CRLF까지 그대로 읽힌다');
  assert.equal(local.load('없는 키'), null, '없는 키는 null');
  local.clear('posts/2026-10-16-a.md');
  assert.equal(local.load('posts/2026-10-16-a.md'), null, '지운 뒤에는 null');
  assert.equal(storage.map.size, 0, '저장소에서도 사라졌다');
});

test('createLocal: 깨진 JSON은 null이고 지우지 않는다', () => {
  const storage = memoryStorage();
  storage.setItem(LOCAL_PREFIX + 'new:abc', '{"meta": 깨짐');
  const local = createLocal(storage);
  assert.equal(local.load('new:abc'), null, '깨진 저장본은 null');
  assert.equal(storage.getItem(LOCAL_PREFIX + 'new:abc'), '{"meta": 깨짐', '깨진 저장본도 손으로 살릴 수 있게 남긴다');
});

test('createLocal: keys()는 접두어 키만, 접두어를 떼고', () => {
  const storage = memoryStorage();
  storage.setItem('blog.editor.auth', '{}');
  storage.setItem('other:posts/x.md', '{}');
  const local = createLocal(storage);
  local.save('new:abc', DATA);
  local.save('posts/예시/글-01.md', DATA);
  assert.deepEqual(local.keys().sort(), ['new:abc', 'posts/예시/글-01.md'], '다른 접두어 키는 나오지 않는다');
});

test('createLocal: 저장 공간이 꽉 차거나 막히면 save가 던진다(저장된 척하지 않는다)', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const local = createLocal(storage);
  assert.throws(() => local.save('new:abc', DATA), /기기에 저장하지 못했어요/, '실패를 알린다');
});

test('createLocal: 저장소 자체를 쓸 수 없으면 save·clear는 던지고 load·keys는 비어 있다', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    get length() { throw new Error('SecurityError'); },
  };
  const local = createLocal(blocked);
  assert.throws(() => local.save('k', DATA), /기기에 저장하지 못했어요/, '저장 실패를 알린다');
  assert.throws(() => local.clear('k'), /기기 저장본을 지우지 못했어요/, '지우기 실패를 알린다');
  assert.equal(local.load('k'), null, '읽을 수 없으면 저장본 없음');
  assert.deepEqual(local.keys(), [], '읽을 수 없으면 키 없음');
});
