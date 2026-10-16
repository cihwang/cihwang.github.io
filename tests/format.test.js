import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFormat } from '../editor/format.js';

test('감싸기 서식', () => {
  assert.deepEqual(applyFormat('가나', 0, 2, 'bold'), { text: '**가나**', start: 2, end: 4 }, '선택 감싸기, 선택 유지');
  assert.deepEqual(applyFormat('가', 1, 1, 'italic'), { text: '가**', start: 2, end: 2 }, '빈 선택이면 기호 사이 커서');
  assert.deepEqual(applyFormat('가', 0, 1, 'strike'), { text: '~~가~~', start: 2, end: 3 }, '취소선도 선택 유지');
});

test('머리 기호 서식', () => {
  assert.equal(applyFormat('a\nb', 0, 3, 'quote').text, '> a\n> b', '걸친 줄마다');
  assert.equal(applyFormat('## a', 0, 0, 'h2').text, 'a', '같은 기호면 토글로 뗀다');
  assert.equal(applyFormat('### a', 0, 0, 'h2').text, '## a', '다른 제목 기호는 바꾼다');
});

test('빈 첫 줄에서도 커서가 있는 줄에 기호를 넣는다', () => {
  assert.deepEqual(applyFormat('\nabc', 0, 0, 'h2'), { text: '## \nabc', start: 3, end: 3 }, '첫 줄이 비어도 그 줄에 제목 기호, 커서는 기호 뒤');
  assert.deepEqual(applyFormat('\nabc', 0, 0, 'quote'), { text: '> \nabc', start: 2, end: 2 }, '첫 줄이 비어도 그 줄에 인용 기호, 커서는 기호 뒤');
});

test('링크와 코드', () => {
  assert.deepEqual(applyFormat('글', 0, 1, 'link'), { text: '[글](https://)', start: 4, end: 12 }, 'URL 자리를 선택');
  assert.equal(applyFormat('a\nb', 0, 3, 'code').text, '```\na\nb\n```', '여러 줄은 블록');
  assert.equal(applyFormat('abc', 0, 3, 'code').text, '`abc`', '한 줄은 백틱 감싸기');
});
