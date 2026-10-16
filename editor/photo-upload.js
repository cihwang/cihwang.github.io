// 쓰기 화면의 사진 올리기: 고른 순간 본문에 자리표시 줄을 넣고, 한 장씩 차례로 줄여 올린 뒤 그 줄을 그림 줄로 바꾼다.
import { MAX_IMAGE_PX } from './config.js';
import { AuthError } from './github.js';
import { resizeImage } from './media.js';

/** 올릴 수 있는 파일: 사진 전부와 mp4·webm 영상(사이트의 그림 문법이 영상도 그린다). */
const ACCEPTED_TYPE = /^(image\/|video\/(mp4|webm)$)/;
/** 자리표시 줄과 그 뒤 줄바꿈 하나. id는 `crypto.randomUUID()` 앞 8자리라 16진수와 `-`뿐이다. */
const PLACEHOLDER_LINE = /!\[올리는 중…\]\(uploading-[\w-]+\)\n?/g;

const placeholderOf = (id) => `![올리는 중…](uploading-${id})`;

/**
 * 본문에 올리는 중 자리표시가 남아 있는지 본다. 남은 채 출간하면 깨진 그림이 공개된다.
 * @param {string} body 마크다운 본문
 * @returns {boolean}
 */
export function hasUploadPlaceholder(body) {
  return body.includes('](uploading-');
}

/**
 * 끝나지 못한 자리표시 줄을 지운다. 올리던 중에 창을 닫거나 새로고침해 기기 저장본에 남은 것들이다.
 * @param {string} body 마크다운 본문
 * @returns {{ body: string, count: number }} 지운 뒤 본문과 지운 줄 수(없으면 0, 본문 그대로)
 */
export function removeUploadPlaceholders(body) {
  let count = 0;
  const cleaned = body.replace(PLACEHOLDER_LINE, () => {
    count += 1;
    return '';
  });
  return { body: cleaned, count };
}

/**
 * 본문 칸에 사진 올리기를 붙인다: 파일 고르기 칸의 change, 본문 붙여넣기(그림만 있을 때), 화면에 끌어다 놓기.
 * 올리기는 넣은 순서대로 한 번에 한 장씩 한다.
 * @param {{ textarea: HTMLTextAreaElement, input: HTMLInputElement, listen: (target: EventTarget, type: string, fn: Function) => void,
 *   upload: (blob: Blob, name: string, rand: string) => Promise<string>, onBodyChange: () => void,
 *   onUploaded: (path: string, blob: Blob) => void, status: (text: string) => void, report: (text: string) => void,
 *   onAuthLost: () => void, isCurrent: () => boolean }} options
 *   `input`은 `type="file"` 칸, `listen`은 화면을 떠날 때 걷히는 이벤트 등록. `upload`은 `store.uploadMedia`(돌려주는 값은 `media/…`).
 *   `onBodyChange`는 칸 내용을 바꾼 뒤 부른다(입력 이벤트가 안 오므로). `status`는 진행 상황(아래 막대),
 *   `report`는 실패처럼 남아 있어야 할 안내. `onAuthLost`는 토큰이 풀렸을 때 한 번 부른다.
 * @returns {{ pick: () => void, pending: () => number }} `pick`은 파일 고르기 창(폰은 사진첩·카메라)을 연다. `pending`은 아직 끝나지 않은 장 수.
 */
export function createPhotoUploader({ textarea, input, listen, upload, onBodyChange, onUploaded, status, report, onAuthLost, isCurrent }) {
  let queue = Promise.resolve();
  let pending = 0;
  let failed = 0; // 이번 묶음에서 못 올린 장 수. 다 끝나면 아래 막대에 알린다(실패 안내는 위쪽이라 폰에서 안 보일 수 있다).
  let composing = false;
  const waiting = new Set();
  // 한글 조합 중에 칸 값을 바꾸면 조합 중인 글자가 깨진다. 조합이 끝난 뒤에 바꾼다.
  let composed = () => {};
  listen(textarea, 'compositionstart', () => { composing = true; });
  listen(textarea, 'compositionend', () => {
    composing = false;
    composed();
  });
  const notComposing = () => (composing ? new Promise((resolve) => { composed = resolve; }) : Promise.resolve());

  /** 자리표시 줄을 바꾼다. 빈 문자열이면 그 줄을 지운다. 사용자가 그 줄을 지웠으면 false. */
  function replacePlaceholder(item, replacement) {
    const text = textarea.value;
    let start = text.indexOf(item.placeholder);
    if (start === -1) return false;
    let end = start + item.placeholder.length;
    if (!replacement) {
      if (text[end] === '\n') end += 1;
      else if (start > 0 && text[start - 1] === '\n') start -= 1;
    }
    // 'preserve': 커서가 바뀌는 줄 뒤에 있으면 그만큼 같이 옮겨, 쓰던 자리가 그대로 남는다.
    textarea.setRangeText(replacement, start, end, 'preserve');
    onBodyChange();
    return true;
  }

  async function uploadOne(item) {
    const name = item.file.name || '붙여넣은 사진';
    try {
      if (!isCurrent()) return;
      status(`사진 올리는 중… (남은 ${pending}장)`);
      let blob;
      try {
        blob = await resizeImage(item.file, MAX_IMAGE_PX);
      } catch (e) {
        throw new Error(`사진을 읽지 못했어요. 다른 형식(jpg·png)으로 다시 골라 주세요. (${e.message})`, { cause: e });
      }
      const path = await upload(blob, name, item.id);
      if (!isCurrent()) return;
      onUploaded(path, blob);
      await notComposing();
      const line = `![](../${path})`;
      if (!replacePlaceholder(item, line)) report(`"${name}"은 올렸지만 자리표시 줄이 지워져서 본문에 넣지 않았어요. 넣으려면 ${line} 을 적어 주세요.`);
    } catch (e) {
      if (!isCurrent()) return;
      if (e instanceof AuthError) {
        // 남은 장도 같은 토큰으로는 못 올린다. 자리표시를 모두 지운 뒤 기기에 저장되게 넘긴다.
        for (const other of waiting) replacePlaceholder(other, '');
        // 이 장은 finally에서 뺀다. 나머지는 차례가 와도 건너뛰므로 여기서 뺀다.
        pending -= waiting.size - 1;
        waiting.clear();
        onAuthLost();
        return;
      }
      failed += 1;
      await notComposing();
      replacePlaceholder(item, '');
      report(`사진을 올리지 못해 그 줄을 지웠어요. (${name}) ${e.message}`);
    } finally {
      waiting.delete(item);
      pending -= 1;
      if (pending === 0 && isCurrent()) {
        status(failed ? `사진 ${failed}장을 올리지 못했어요. 화면 위 안내를 확인해 주세요.` : '사진 올리기가 끝났어요.');
        failed = 0;
      }
    }
  }

  /** 파일들을 커서 자리(선택 영역은 지우지 않고 그 끝)에 한 줄씩 넣고 차례로 올린다. 사진·영상이 아닌 파일은 빼고 알린다. */
  function add(files) {
    const all = [...files];
    const skipped = all.filter((f) => !ACCEPTED_TYPE.test(f.type));
    if (skipped.length) report(`사진·영상(mp4·webm)만 올릴 수 있어요. 넣지 않은 파일: ${skipped.map((f) => f.name || '이름 없음').join(', ')}`);
    const items = all.filter((f) => ACCEPTED_TYPE.test(f.type)).map((file) => {
      const id = crypto.randomUUID().slice(0, 8);
      return { file, id, placeholder: placeholderOf(id) };
    });
    if (!items.length) return;
    const text = textarea.value;
    const at = textarea.selectionEnd;
    const before = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
    const after = text[at] === '\n' ? '' : '\n';
    textarea.setRangeText(before + items.map((i) => i.placeholder).join('\n') + after, at, at, 'end');
    onBodyChange();
    pending += items.length;
    for (const item of items) {
      waiting.add(item);
      queue = queue.then(() => (waiting.has(item) ? uploadOne(item) : undefined));
    }
  }

  listen(input, 'change', () => {
    add(input.files);
    // 같은 파일을 다시 골라도 change가 오게 비운다(add는 파일을 이미 배열로 옮겼다).
    input.value = '';
  });
  // 글과 그림이 같이 복사된 것(워드·엑셀 등)은 글로 붙인다. 그림만 있을 때(화면 캡처 등) 올린다.
  listen(textarea, 'paste', (e) => {
    const files = e.clipboardData?.files;
    if (!files?.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    add(files);
  });
  // 파일을 화면 어디에 떨어뜨려도 브라우저가 그 파일을 열며 이 화면을 떠나지 않게 막고, 본문 커서 자리에 넣는다.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  listen(window, 'dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  listen(window, 'drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!document.querySelector('dialog[open]')) add(e.dataTransfer.files);
  });

  return { pick: () => input.click(), pending: () => pending };
}
