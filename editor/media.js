/**
 * 본문에서 설명(alt)이 빈 그림 `![](` 의 개수를 센다.
 * @param {string} body 머리말을 뗀 마크다운 본문
 * @returns {number} 빈 설명 그림 수. 본문이 비면 0.
 */
export function countEmptyAlt(body) {
  return body.split('![](').length - 1;
}

const RESIZABLE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOSSY_QUALITY = 0.9;

/**
 * 긴 변이 `max` 이하가 되도록 비율을 유지해 줄인 크기를 구한다.
 * @param {number} w 원본 너비(px)
 * @param {number} h 원본 높이(px)
 * @param {number} max 긴 변 상한(px)
 * @returns {{w: number, h: number}} 반올림한 정수 크기. 이미 작으면 원본 그대로이고 늘리지 않는다.
 */
export function fitWithin(w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * 올린 파일의 저장 경로 `media/YYYYMMDD-HHmmss-<rand>.<ext>` 를 만든다.
 * 날짜·시간은 `now` 의 기기(로컬) 시간이며 서울 시간으로 바꾸지 않는다.
 * @param {string} originalName 원본 파일 이름
 * @param {Date} now 기준 시각
 * @param {string} rand 같은 초의 충돌을 피할 무작위 문자열(호출자가 만든다)
 * @returns {string} 저장소 루트 기준 상대 경로. 확장자는 소문자이고 `jpeg` 는 `jpg`, 확장자가 없으면 `bin`.
 */
export function mediaFileName(originalName, now, rand) {
  const dot = originalName.lastIndexOf('.');
  let ext = dot === -1 ? '' : originalName.slice(dot + 1).toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!ext) ext = 'bin';
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `media/${date}-${time}-${rand}.${ext}`;
}

/**
 * 본문이 `](../media/…)` 로 가리키는 사진·영상 경로를 모은다.
 * @param {string} body 머리말을 뗀 마크다운 본문
 * @returns {string[]} `media/…` 경로(`../` 와 제목·`#loop` 는 뗀다). 처음 나온 순서, 중복 없음.
 */
export function mediaRefs(body) {
  const found = [...body.matchAll(/\]\(\.\.\/(media\/[^)\s#"]+)/g)].map((m) => m[1]);
  return [...new Set(found)];
}

/**
 * 큰 사진을 긴 변 `max` 이하로 줄인 Blob 을 만든다. 브라우저 전용(`createImageBitmap` + canvas).
 * png·jpeg·webp 만 줄이며, gif·svg·영상이나 이미 작은 사진은 원본 `file` 을 그대로 돌려준다.
 * 줄인 결과는 원본과 같은 형식이고 jpeg·webp 품질은 0.9 이다.
 * @param {Blob} file 올린 파일
 * @param {number} max 긴 변 상한(px)
 * @returns {Promise<Blob>} 줄인 사진, 또는 원본 `file`
 * @throws {Error} 이미지를 해독하지 못하거나 canvas 변환에 실패할 때
 */
export async function resizeImage(file, max) {
  if (!RESIZABLE_TYPES.includes(file.type)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const { w, h } = fitWithin(bitmap.width, bitmap.height, max);
    if (w === bitmap.width && h === bitmap.height) return file;
    const quality = file.type === 'image/png' ? undefined : LOSSY_QUALITY;
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      return await canvas.convertToBlob({ type: file.type, quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('사진 변환 실패'))), file.type, quality);
    });
  } finally {
    bitmap.close();
  }
}
