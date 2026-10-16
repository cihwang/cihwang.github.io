/**
 * 글 파일(머리말 + 마크다운 본문)의 읽기·쓰기·검사. 브라우저에서 돌므로 node: 모듈을 쓰지 않는다.
 */
import { splitFrontMatter } from '../markdown.js';
import { countEmptyAlt } from './media.js';

const KEY_ORDER = ['title', 'category', 'date', 'slug', 'draft'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_MAX_LENGTH = 20;
// 따옴표는 카테고리 바꾸기(recategorize) 뒤 머리말을 읽을 때 벗겨져 이름이 달라지고 build.js가 실패한다.
const CATEGORY_FORBIDDEN = /[/#?%"']/;

/**
 * 글 파일 텍스트를 머리말과 본문으로 나눈다.
 * @param {string} text 글 파일 전체. CRLF는 LF로 바꿔서 읽는다.
 * @returns {{meta: Record<string,string>, body: string}} 머리말이 없으면 meta는 빈 객체
 */
export function parsePost(text) {
  return splitFrontMatter(text.replace(/\r\n/g, '\n'));
}

/**
 * 머리말과 본문을 글 파일 텍스트로 만든다.
 * @param {Record<string,string|boolean>} meta 값이 빈 항목은 쓰지 않는다. 알려진 키(title, category, date, slug, draft)가 먼저, 나머지는 들어온 순서.
 * @param {string} body 본문. 끝은 줄바꿈 하나로 맞추고, 비면 본문 없이 머리말만 쓴다.
 * @returns {string} LF 줄바꿈의 글 파일 전체
 */
export function serializePost(meta, body) {
  const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k))];
  const lines = [];
  for (const key of keys) {
    // 줄바꿈이 값에 섞이면 머리말 줄이 깨지므로 공백으로 바꾼다.
    const value = String(meta[key] ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (!value) continue;
    // 읽을 때 따옴표를 벗기므로, 값이 따옴표로 감싸여 있으면 한 겹 더 감싸 왕복을 맞춘다.
    const quoted = /^(["']).*\1$/.test(value) ? `"${value}"` : value;
    lines.push(`${key}: ${quoted}`);
  }
  const trimmedBody = body.replace(/\n+$/, '');
  return `---\n${lines.join('\n')}\n---\n${trimmedBody ? trimmedBody + '\n' : ''}`;
}

/**
 * 제목에서 주소(slug)를 만든다: 소문자, 공백은 `-`, 글자·숫자·`-` 외에는 지운다.
 * @param {string} title 글 제목
 * @returns {string} slug. 쓸 글자가 하나도 없으면 'post'
 */
export function slugFromTitle(title) {
  const slug = title.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'post';
}

/**
 * 글 파일의 저장소 안 경로를 만든다.
 * @param {string} date YYYY-MM-DD
 * @param {string} slug 글 주소
 * @returns {string} `posts/날짜-slug.md`
 */
export function postPath(date, slug) {
  return `posts/${date}-${slug}.md`;
}

/**
 * 편집 주소(`#/edit?path=`)로 열어도 되는 글 경로인지 본다. 주소는 누구나 만들 수 있어 저장소의 다른 파일을 글로 열지 않게 한다.
 * @param {string} path 저장소 안 경로
 * @returns {boolean} `posts/`로 시작하고 `.md`로 끝나며 `..` 조각과 역슬래시가 없으면 true
 */
export function isPostPath(path) {
  return path.startsWith('posts/') && path.endsWith('.md') && !path.includes('\\') && !path.split('/').includes('..');
}

/**
 * 초안 저장 전 검사: 제목이 있고 카테고리가 목록에 있어야 한다.
 * @param {Record<string,string>} meta 글 머리말
 * @param {string[]} categories 허용하는 카테고리 이름들
 * @returns {string[]} 사용자에게 보여줄 오류 문구. 비어 있으면 통과.
 */
export function validateDraft(meta, categories) {
  const errors = [];
  if (!(meta.title ?? '').trim()) errors.push('제목을 입력해 주세요');
  if (!categories.includes(meta.category)) errors.push('카테고리를 목록에서 골라 주세요');
  return errors;
}

/**
 * 공개 전 검사. 오류가 있으면 공개할 수 없고, 경고는 확인만 받는다.
 * @param {Record<string,string>} meta 글 머리말
 * @param {string} body 마크다운 본문
 * @param {{categories: string[], livePosts: {path:string, cat:string, slug:string}[], ownPath: string|null}} context
 *   livePosts는 이미 공개된 글. ownPath는 지금 편집 중인 글의 기존 경로(새 글이면 null)이며 겹침 검사에서 뺀다.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePublish(meta, body, { categories, livePosts, ownPath }) {
  const errors = validateDraft(meta, categories);
  const warnings = [];
  if (!DATE_FORMAT.test(meta.date ?? '')) errors.push('날짜를 YYYY-MM-DD 형식으로 적어 주세요');
  if (!(meta.slug ?? '').trim()) {
    errors.push('주소(slug)를 입력해 주세요');
  } else if (livePosts.some((p) => p.path !== ownPath && p.cat === meta.category && p.slug === meta.slug)) {
    errors.push('같은 카테고리에 같은 주소(slug)의 글이 이미 있어요');
  }
  const emptyAlt = countEmptyAlt(body);
  if (emptyAlt > 0) warnings.push(`설명이 빈 그림이 ${emptyAlt}개 있어요`);
  const own = ownPath && livePosts.find((p) => p.path === ownPath);
  if (own && own.slug !== meta.slug) warnings.push('공개된 글의 주소(slug)를 바꾸면 기존 링크가 끊겨요');
  // 사이트 글 주소가 #/카테고리/slug라 카테고리를 바꿔도 옛 링크가 끊긴다.
  if (own && own.cat !== meta.category) warnings.push('공개된 글의 카테고리를 바꾸면 기존 링크가 끊겨요');
  return { errors, warnings };
}

/**
 * 새 카테고리 이름을 검사한다. 앞뒤 공백은 뗀 뒤 본다.
 * @param {string} name 입력한 이름
 * @param {string[]} existing 이미 있는 카테고리 이름들
 * @returns {string[]} 오류 문구. 비어 있으면 사용 가능.
 */
export function validateCategoryName(name, existing) {
  const trimmed = name.trim();
  const errors = [];
  if (trimmed.length < 1 || trimmed.length > CATEGORY_MAX_LENGTH) errors.push(`이름은 1~${CATEGORY_MAX_LENGTH}자로 적어 주세요`);
  if (CATEGORY_FORBIDDEN.test(trimmed)) errors.push('이름에 / # ? % " \' 는 쓸 수 없어요');
  if (trimmed.startsWith('_')) errors.push('이름은 _ 로 시작할 수 없어요');
  if (existing.includes(trimmed)) errors.push('이미 있는 카테고리예요');
  return errors;
}

/**
 * 글의 머리말 category 줄만 바꾼다. 다른 줄·본문·줄바꿈(CRLF 포함)은 그대로 둔다.
 * @param {string} text 글 파일 전체
 * @param {string} from 현재 카테고리
 * @param {string} to 새 카테고리
 * @returns {string|null} 바뀐 글 전체. category가 from이 아니거나 머리말에 없으면 null.
 */
export function recategorize(text, from, to) {
  const front = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!front) return null;
  const line = /^(category[ \t]*:[ \t]*)(.*?)([ \t]*)$/m.exec(front[2]);
  if (!line || line[2].replace(/^(["'])(.*)\1$/, '$2') !== from) return null;
  const header = front[2].slice(0, line.index) + line[1] + to + line[3] + front[2].slice(line.index + line[0].length);
  return front[1] + header + text.slice(front[1].length + front[2].length);
}
