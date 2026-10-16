import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// write.html은 토큰을 쥔 페이지라 CSP로 미리보기 속 HTML의 스크립트를 막는다. 안의 <script>를 고치면 해시도 바꿔야
// 에디터가 뜬다. 이 테스트가 그 해시를 다시 계산해 CSP와 맞는지 본다(실패 메시지에 넣을 값이 나온다).
const html = readFileSync(new URL('../write.html', import.meta.url), 'utf8');
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
const inlineScripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// 브라우저는 HTML을 읽을 때 CRLF를 LF로 바꾼 뒤의 스크립트 글자로 해시를 잰다(git도 LF로 저장해 Pages가 LF로 보낸다).
// Windows 체크아웃(autocrlf)에서도 같은 값이 나오게 LF로 맞춰 잰다.
const hashOf = (text) => `'sha256-${createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;

test('CSP: <head>의 맨 앞에 있다(그 앞의 스크립트·스타일은 막지 못한다)', () => {
  assert.ok(csp, 'write.html에 CSP meta가 있다');
  assert.match(html, /<head>\s*<meta http-equiv="Content-Security-Policy"/, 'CSP meta가 <head>의 첫 요소');
  assert.ok(html.indexOf('<meta charset="utf-8">') + 30 < 1024, 'charset 선언은 문서 앞 1024바이트 안에 있어야 한다');
});

test('CSP: 인라인 스크립트마다 sha256 해시가 script-src에 있고, unsafe-inline·unsafe-eval은 없다', () => {
  const scriptSrc = directives['script-src'] ?? [];
  assert.equal(inlineScripts.length, 2, '인라인 스크립트는 테마 결정과 importmap 둘');
  for (const text of inlineScripts) {
    assert.ok(scriptSrc.includes(hashOf(text)), `script-src에 ${hashOf(text)}가 있어야 한다(인라인 스크립트를 고쳤으면 해시도 바꾼다)`);
  }
  const hashes = scriptSrc.filter((s) => s.startsWith("'sha256-"));
  assert.equal(hashes.length, inlineScripts.length, '지금 없는 스크립트의 옛 해시를 남기지 않는다');
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), '미리보기 HTML의 인라인 스크립트·eval이 돌지 않게');
  assert.deepEqual(directives['default-src'], ["'none'"], '적지 않은 종류는 모두 막는다');
  assert.deepEqual(directives['object-src'], ["'none'"], '플러그인 막기');
  assert.deepEqual(directives['base-uri'], ["'none'"], '<base>로 상대 주소를 바꾸지 못하게');
});

test('CSP: write.html이 쓰는 바깥 글꼴 CSS의 호스트만 style-src에 있다', () => {
  const hosts = [...html.matchAll(/<link href="(https:\/\/[^/"]+)\//g)].map((m) => m[1]);
  assert.ok(hosts.length > 0, '바깥 글꼴 CSS를 찾았다');
  for (const host of hosts) {
    assert.ok(directives['style-src']?.includes(host), `style-src에 ${host}`);
    assert.ok(directives['font-src']?.includes(host), `font-src에 ${host}`);
  }
});
