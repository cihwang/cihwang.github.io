// 쓰기 화면의 도움말 창: 블로그 저장소의 posts/_글쓰기-도움말.md를 미리보기와 같은 renderMarkdown으로 그려 보여 준다.
import { renderMarkdown } from '../markdown.js';
import { BLOG_REPO } from './config.js';
import { AuthError } from './github.js';
import { parsePost } from './post.js';
import { $, failText, followRenderedLink } from './ui.js';

const HELP_PATH = 'posts/_글쓰기-도움말.md';

/**
 * 도움말 창을 붙인다. 내용은 처음 열 때 한 번 받고, 실패하면 다음에 열 때 다시 받는다.
 * @param {{ dialog: HTMLDialogElement, gh: object, loseLogin: () => void, isCurrent: () => boolean }} ctx
 * @returns {{ open: () => void }}
 */
export function createHelpDialog({ dialog, gh, loseLogin, isCurrent }) {
  const title = $(dialog, 'help-title');
  const msg = $(dialog, 'help-msg');
  const body = $(dialog, 'help-body');
  let state = 'empty'; // 'empty' | 'loading' | 'loaded'

  async function load() {
    state = 'loading';
    msg.textContent = '불러오는 중…';
    try {
      const file = await gh.getFile(BLOG_REPO, HELP_PATH);
      if (!isCurrent()) return;
      if (!file) {
        state = 'empty';
        msg.textContent = `블로그 저장소에 도움말 파일(${HELP_PATH})이 없어요.`;
        return;
      }
      const { meta, body: markdown } = parsePost(file.text);
      title.textContent = meta.title || '글쓰기 도움말';
      // 블로그 저장소의 내 글을 build.js와 같은 renderMarkdown으로 그린 것이라 미리보기처럼 innerHTML로 넣는다.
      body.innerHTML = renderMarkdown(markdown);
      msg.textContent = '';
      state = 'loaded';
    } catch (e) {
      if (!isCurrent()) return;
      state = 'empty';
      if (e instanceof AuthError) {
        dialog.close();
        return loseLogin();
      }
      msg.textContent = `도움말을 불러오지 못했어요. 닫았다 다시 열면 다시 받아요. ${failText(e)}`;
    }
  }

  $(dialog, 'help-close').addEventListener('click', () => dialog.close());
  // 창 바깥(어두운 배경)을 누르면 닫는다(사이트 도움말 help.js와 같다).
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  body.addEventListener('click', (e) => followRenderedLink(body, e));

  return {
    open() {
      if (dialog.open) return;
      dialog.showModal();
      if (state === 'empty') load();
    },
  };
}
