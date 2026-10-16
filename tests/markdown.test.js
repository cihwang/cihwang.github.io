import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, renderMarkdown, slugFromPath } from '../markdown.js';

test('머리말과 본문을 나눈다(CRLF 포함)', () => {
  const { meta, body } = splitFrontMatter('---\r\ntitle: "가: 나"\r\ncategory: 공부\r\n---\r\n본문');
  assert.equal(meta.title, '가: 나', '첫 콜론에서만 나누고 따옴표는 벗긴다');
  assert.equal(meta.category, '공부', 'CRLF 머리말도 읽는다');
  assert.equal(body, '본문', '머리말 뒤가 본문');
});
test('제목 id는 글마다 새로 센다', () => {
  assert.match(renderMarkdown('## 가\n'), /id="h-가"/, '첫 렌더');
  assert.match(renderMarkdown('## 가\n'), /id="h-가"/, '두 번째 렌더도 -1이 붙지 않아야 한다(resetHeadings)');
});
test('빈 본문은 빈 문자열', () => assert.equal(renderMarkdown('  \n'), '', 'build.js와 같은 규칙'));
test('그림 문법의 ../media/는 media/로', () =>
  assert.match(renderMarkdown('![a](../media/x.png)'), /src="media\/x.png"/, '사이트 기준 경로'));
test('slug는 파일 이름에서 날짜를 뗀 것', () => {
  assert.equal(slugFromPath('posts/2026-10-13-agentforce-coworker.md'), 'agentforce-coworker', '날짜 접두어 제거');
  assert.equal(slugFromPath('posts/예시/공부-01.md'), '공부-01', '날짜 없는 이름은 그대로');
});
