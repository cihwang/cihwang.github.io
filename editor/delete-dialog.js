// 쓰기 화면의 삭제: 확인을 받은 뒤 GitHub에서 지우고, 그다음에만 기기 저장본을 지운다(순서가 반대면 실패 때 글이 사라진다).
import { AuthError, GitHubError } from './github.js';
import { failText } from './ui.js';

function deleteQuestion(doc) {
  const name = doc.meta.title || '(제목 없음)';
  if (doc.blogPath) {
    const draft = doc.draftPath ? ' 고치던 내용(초안)은 임시글 목록에 남아요.' : '';
    return `"${name}" 글을 지울까요? 사이트에서 사라져요. 블로그 저장소에 커밋이 하나 생기고, 사진은 지우지 않아요.${draft}`;
  }
  if (doc.draftPath) return `"${name}" 초안을 지울까요? 되돌릴 수 없어요.`;
  return `"${name}" 글을 이 기기에서 지울까요? GitHub에 올린 적 없는 글이라 되돌릴 수 없어요.`;
}

/**
 * 열린 글을 지운다. 공개된 글이면 `deletePost`(블로그 한 커밋), 초안이면 열 때 받은 sha로 `deleteDraft`,
 * 이 기기에만 있는 새 글이면 기기 저장본만 지운다. 끝나면 목록으로 간다.
 * 초안 sha가 그 사이 바뀌었으면(다른 기기 저장) 지우지 않고 알린다.
 * @param {{ ask: (message: string, choices: object[]) => Promise<string>, getDoc: () => object, store: object,
 *   saveLocal: () => boolean, stopLocal: () => void, dropLocal: () => string|null, goTo: (hash: string, notice: string) => void,
 *   setStatus: (text: string) => void, loseLogin: () => void, isCurrent: () => boolean }} ctx
 *   `dropLocal`은 기기 저장본을 지우고 못 지우면 그 이유 문장을 돌려준다.
 */
export async function deleteOpenDoc(ctx) {
  const doc = ctx.getDoc();
  const choice = await ctx.ask(deleteQuestion(doc), [{ label: '취소', value: '' }, { label: '삭제', value: 'delete', primary: true }]);
  if (choice !== 'delete' || !ctx.isCurrent()) return;
  ctx.setStatus('지우는 중…');
  try {
    if (doc.blogPath) await ctx.store.deletePost(doc.blogPath);
    else if (doc.draftPath) await ctx.store.deleteDraft(doc.draftPath, doc.draftSha);
  } catch (e) {
    if (!ctx.isCurrent()) return;
    if (e instanceof AuthError) return ctx.loseLogin();
    const moved = doc.blogPath ? '공개된 글이 그 사이 다른 곳에서 바뀌었어요.' : '다른 기기에서 이 초안을 먼저 저장했어요.';
    const reason = e instanceof GitHubError && e.status === 409 ? `${moved} 목록에서 다시 열어 확인한 뒤 지워 주세요.` : failText(e);
    return ctx.setStatus(`지우지 못했어요. ${reason}`);
  }
  if (doc.blogPath && doc.draftPath) {
    // 공개본만 지웠고 초안 저장소의 고치던 내용은 남는다. 그 기기 저장본도 지금 내용으로 남겨 둔다.
    ctx.saveLocal();
    ctx.stopLocal();
    if (ctx.isCurrent()) ctx.goTo('#/', '공개된 글을 지웠어요. 고치던 내용은 임시글 목록에 남아 있어요.');
    return;
  }
  ctx.stopLocal();
  const notCleared = ctx.dropLocal();
  if (ctx.isCurrent()) ctx.goTo('#/', notCleared ? `GitHub에서는 지웠지만 ${notCleared}` : '지웠어요.');
}
