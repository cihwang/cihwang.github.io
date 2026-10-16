import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateHighlightModule } from '../tools/vendor.js';

test('lib/index.js와 같은 언어를 모두 등록한다', () => {
  const src = generateHighlightModule('node_modules');
  const want = (readFileSync('node_modules/highlight.js/lib/index.js', 'utf8').match(/registerLanguage\(/g) || []).length;
  // core.js 본문에도 registerLanguage 정의·unregisterLanguage 줄이 들어 있어 그만큼은 뺀다.
  const inCore = (readFileSync('node_modules/highlight.js/lib/core.js', 'utf8').match(/registerLanguage\(/g) || []).length;
  const got = (src.match(/registerLanguage\(/g) || []).length - inCore;
  assert.ok(want > 100, '기준 언어 수를 제대로 읽었는지');
  assert.equal(got, want, '브라우저 미리보기도 사이트와 같은 언어를 칠해야 한다');
  assert.ok(!/\brequire\(/.test(src), '브라우저에서 돌아야 하므로 require가 남으면 안 된다');
  assert.match(src, /export default module\.exports/, '기본 내보내기가 hljs');
});
