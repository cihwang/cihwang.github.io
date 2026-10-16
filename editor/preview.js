// 쓰기 화면의 미리보기: build.js와 같은 renderMarkdown으로 그리고, 비공개 초안 저장소의 사진은 토큰으로 받아 보여 준다.
import { renderMarkdown } from '../markdown.js';
import { SITE_URL } from './config.js';

/**
 * 미리보기 칸을 만든다.
 * @param {{ titleEl: HTMLElement, bodyEl: HTMLElement, gh: object, draftsRepo: string, getDoc: () => object,
 *   isCurrent: () => boolean }} options `getDoc`은 지금 글(`{ meta, body }`), `isCurrent`는 쓰기 화면이 아직 떠 있는지.
 * @returns {{ render: () => void, remember: (path: string, blob: Blob) => void, revokeAll: () => void }}
 *   `render`는 지금 글을 다시 그린다. `remember`는 방금 올린 사진(`media/…`)을 다시 받지 않고 그 blob으로 보이게 한다.
 *   `revokeAll`은 화면을 떠날 때 만든 blob 주소를 모두 푼다.
 */
export function createPreview({ titleEl, bodyEl, gh, draftsRepo, getDoc, isCurrent }) {
  // 'media/…' → blob URL | null(초안 저장소에 없음 → 사이트 주소) | 'pending'
  const media = new Map();

  async function fetchMedia(path) {
    media.set(path, 'pending');
    let url = null;
    try {
      const blob = await gh.getRaw(draftsRepo, path);
      url = blob && URL.createObjectURL(blob);
    } catch {
      // 미리보기만의 일이다. 초안 저장소에서 못 받으면 사이트 주소로 보여 주고, 인증·저장 오류는 저장할 때 알린다.
    }
    if (!isCurrent()) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    media.set(path, url);
    render();
  }

  function render() {
    const doc = getDoc();
    titleEl.textContent = doc.meta.title ?? '';
    const tpl = document.createElement('template');
    tpl.innerHTML = renderMarkdown(doc.body);
    // 초안 저장소는 비공개라 주소로는 못 받는다. 토큰으로 받은 blob으로 바꾸고, 없으면 사이트에 이미 있는 사진으로 본다.
    for (const node of tpl.content.querySelectorAll('img[src^="media/"], video[src^="media/"]')) {
      const path = node.getAttribute('src');
      const url = media.get(path);
      if (url === undefined) fetchMedia(path);
      if (url === undefined || url === 'pending') node.removeAttribute('src');
      else node.src = url ?? SITE_URL + path;
    }
    bodyEl.replaceChildren(tpl.content);
  }

  return {
    render,
    remember(path, blob) {
      if (!media.has(path)) media.set(path, URL.createObjectURL(blob));
    },
    revokeAll() {
      for (const url of media.values()) if (url && url !== 'pending') URL.revokeObjectURL(url);
    },
  };
}
