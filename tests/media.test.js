import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, mediaFileName, mediaRefs, countEmptyAlt } from '../editor/media.js';

test('긴 변 줄이기', () => {
  assert.deepEqual(fitWithin(4032, 3024, 2000), { w: 2000, h: 1500 }, '긴 변 2000');
  assert.deepEqual(fitWithin(800, 600, 2000), { w: 800, h: 600 }, '작으면 그대로');
});

test('사진 파일 이름과 참조', () => {
  assert.equal(mediaFileName('IMG.JPEG', new Date(2026, 9, 16, 14, 53, 1), 'ab12'), 'media/20261016-145301-ab12.jpg', '이름 규칙');
  assert.equal(mediaFileName('noext', new Date(2026, 0, 2, 3, 4, 5), 'x'), 'media/20260102-030405-x.bin', '확장자 없으면 bin');
  assert.deepEqual(mediaRefs('![](../media/a.png) ![x](../media/v.mp4#loop "t") ![](../media/a.png)'), ['media/a.png', 'media/v.mp4'], '경로만, 중복 없이');
});

test('빈 설명 그림 수', () => {
  assert.equal(countEmptyAlt('![](a) ![b](c) ![](d)'), 2, '설명 빈 그림 수');
});
