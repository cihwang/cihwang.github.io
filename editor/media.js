/**
 * 본문에서 설명(alt)이 빈 그림 `![](` 의 개수를 센다.
 * @param {string} body 머리말을 뗀 마크다운 본문
 * @returns {number} 빈 설명 그림 수. 본문이 비면 0.
 */
export function countEmptyAlt(body) {
  return body.split('![](').length - 1;
}
