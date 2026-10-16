const LINE_PREFIX = { h2: '## ', h3: '### ', h4: '#### ', quote: '> ' };
const WRAP = { bold: '**', italic: '*', strike: '~~' };
const HEADING = /^#{1,6} /;

function prefixLines(text, start, end, kind) {
  const prefix = LINE_PREFIX[kind];
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const found = text.indexOf('\n', end);
  const to = found === -1 ? text.length : found;
  const lines = text.slice(from, to).split('\n');
  const isHeading = kind !== 'quote';
  const allHave = lines.every((line) => line.startsWith(prefix));
  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines.map((line, i) => {
    // 제목은 다른 단계 기호를 먼저 떼고, 인용은 기호가 없는 줄에만 붙인다.
    const stripped = allHave ? line.slice(prefix.length) : isHeading ? line.replace(HEADING, '') : line;
    const result = allHave ? stripped : prefix + stripped;
    const delta = result.length - line.length;
    if (i === 0) firstDelta = delta;
    totalDelta += delta;
    return result;
  });
  const newStart = Math.max(from, start + firstDelta);
  return {
    text: text.slice(0, from) + next.join('\n') + text.slice(to),
    start: newStart,
    end: Math.max(newStart, end + totalDelta),
  };
}

/**
 * 선택 범위에 마크다운 서식을 입힌 새 글과 선택 범위를 돌려준다.
 * 위치는 `<textarea>` 가 알려 주는 UTF-16 인덱스이고 `end` 는 선택 끝(미포함)이다.
 * `start === end` 는 선택이 없는 커서 상태다.
 * 머리 기호(h2~h4, quote)는 같은 기호가 이미 있으면 떼는 토글이며, 선택이 걸친 모든 줄에 적용된다.
 * @param {string} text 현재 글 전체
 * @param {number} start 선택 시작 인덱스
 * @param {number} end 선택 끝 인덱스
 * @param {'h2'|'h3'|'h4'|'bold'|'italic'|'strike'|'quote'|'link'|'code'} kind 서식 종류
 * @returns {{text: string, start: number, end: number}} 새 글과, 서식 뒤 textarea 에 복원할 선택 범위
 * @throws {Error} 모르는 `kind` 일 때
 */
export function applyFormat(text, start, end, kind) {
  if (LINE_PREFIX[kind]) return prefixLines(text, start, end, kind);
  const before = text.slice(0, start);
  const sel = text.slice(start, end);
  const after = text.slice(end);
  if (WRAP[kind]) {
    const m = WRAP[kind];
    return { text: before + m + sel + m + after, start: start + m.length, end: end + m.length };
  }
  if (kind === 'link') {
    const urlStart = start + 1 + sel.length + 2;
    return { text: `${before}[${sel}](https://)${after}`, start: urlStart, end: urlStart + 'https://'.length };
  }
  if (kind === 'code') {
    if (sel && !sel.includes('\n')) {
      return { text: `${before}\`${sel}\`${after}`, start: start + 1, end: end + 1 };
    }
    return { text: `${before}\`\`\`\n${sel}\n\`\`\`${after}`, start: start + 4, end: end + 4 };
  }
  throw new Error(`알 수 없는 서식: ${kind}`);
}
