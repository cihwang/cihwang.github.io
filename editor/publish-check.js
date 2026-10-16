// 출간 설정 창의 검사. validatePublish 결과를 칸별로 나누고, 창에서만 아는 막을 이유를 더한다. DOM을 쓰지 않는다.
import { validatePublish } from './post.js';
import { hasUploadPlaceholder } from './photo-upload.js';

// 파일 경로(posts/날짜-slug.md)와 사이트 주소(#/카테고리/slug)를 깨뜨리는 글자.
const SLUG_FORBIDDEN = /[\s/\\?#%]/;
// validatePublish 문구 → 칸. "같은 카테고리에 같은 주소(slug)…"는 주소 칸 오류라 '주소'를 먼저 본다.
const FIELD_WORDS = [['주소', 'slug'], ['날짜', 'date'], ['카테고리', 'category']];

/**
 * 출간해도 되는지 검사한다.
 * @param {Record<string,string>} meta 창에서 고른 카테고리·날짜·slug를 덮은 머리말
 * @param {string} body 마크다운 본문
 * @param {{ categories: string[]|null, livePosts: { path: string, cat: string, slug: string }[]|null,
 *   ownPath: string|null, uploading: number }} context `categories`·`livePosts`가 null이면 받지 못한 것이고,
 *   그때는 카테고리·주소 겹침을 확인할 수 없어 막는다. `ownPath`는 공개된 글의 경로(새 글은 null), `uploading`은 올리는 중인 사진 수.
 * @returns {{ ok: boolean, top: string[], fields: { category: string[], date: string[], slug: string[] }, warnings: string[] }}
 *   `top`은 칸에 속하지 않는 오류(제목 등). `top`이나 `fields`에 하나라도 있으면 `ok`가 false다. 경고는 막지 않는다.
 */
export function checkPublish(meta, body, { categories, livePosts, ownPath, uploading }) {
  const top = [];
  const fields = { category: [], date: [], slug: [] };
  if (!categories) top.push('카테고리 목록(site.json)을 불러오지 못했어요. 창을 닫았다 다시 열어 주세요');
  if (!livePosts) top.push('사이트 글 목록을 불러오지 못해 주소 겹침을 확인할 수 없어요. 창을 닫았다 다시 열어 주세요');
  const { errors, warnings } = validatePublish(meta, body, { categories: categories ?? [], livePosts: livePosts ?? [], ownPath });
  for (const error of errors) {
    const field = FIELD_WORDS.find(([word]) => error.includes(word))?.[1];
    (field ? fields[field] : top).push(error);
  }
  if (SLUG_FORBIDDEN.test(meta.slug ?? '')) fields.slug.push('주소(slug)에는 공백과 / \\ ? # % 를 쓸 수 없어요');
  if (uploading > 0) top.push('사진을 올리는 중이에요. 다 올라간 뒤 출간해 주세요');
  else if (hasUploadPlaceholder(body)) top.push('본문에 끝나지 않은 사진 자리("올리는 중…")가 있어요. 그 줄을 지운 뒤 출간해 주세요');
  const ok = !top.length && !Object.values(fields).some((list) => list.length);
  return { ok, top, fields, warnings };
}
