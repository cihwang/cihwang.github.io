// 임시저장이 다른 기기의 저장과 부딪혔을 때, 또는 출간·삭제가 그 사이 바뀐 공개본과 부딪혔을 때
// 어느 쪽을 남길지 묻고 고른 대로 한다. 고르기 전에는 아무것도 덮지 않는다.
import { slugFromPath } from '../markdown.js';
import { AuthError, ConflictError, GitHubError } from './github.js';
import { editHash, failText, local, postUrl, shownUrl } from './ui.js';

/**
 * 임시저장 오류가 "다른 곳에서 먼저 바뀜"인지 본다.
 * 기기 저장본으로 다시 연 글은 그 사이 다른 곳에서 지워진 초안의 옛 sha를 들고 있을 수 있는데, 없는 파일에 sha를 붙여 쓰면
 * GitHub는 409가 아니라 404·422로 답한다. 그것도 충돌로 본다.
 * @param {unknown} e `store.saveDraft`가 던진 오류
 * @param {{ draftPath: string|null, draftSha: string|null, blogPath: string|null }} sent 저장하려고 보낸 Doc
 * @returns {boolean} 경로가 아직 없는 새 글은 늘 false다 — 부딪힌 것은 같은 날짜·주소의 다른 초안이라 이 창으로 고를 일이 아니다.
 */
export function isSaveConflict(e, sent) {
  if (!sent.draftPath && !sent.blogPath) return false;
  if (e instanceof ConflictError) return true;
  return e instanceof GitHubError && (e.status === 404 || e.status === 422) && Boolean(sent.draftSha);
}

/**
 * 충돌 창을 띄우고 고른 대로 한다. 두 선택 모두 먼저 초안 저장소에서 그 글을 새로 읽는다.
 * - 다른 기기 내용 불러오기: 지금 내용을 새 기기 저장 키(`new:…`, 목록의 "이 기기에만 있음")에 따로 남긴 뒤 GitHub 내용으로 다시 연다.
 *   따로 남기지 못하면 불러오지 않는다.
 * - 내 것으로 덮어쓰기: 방금 읽은 sha(초안이 지워졌으면 없음)로 다시 임시저장한다. 그 사이 또 바뀌면 이 창이 다시 뜬다.
 * @param {{ ask: (message: string, choices: object[]) => Promise<string>, getDoc: () => object, key: () => string,
 *   gh: object, draftsRepo: string, localFailed: () => boolean, setStatus: (text: string) => void, stopLocal: () => void,
 *   goTo: (hash: string, notice: string) => void, retrySave: () => Promise<void>, loseLogin: () => void,
 *   isCurrent: () => boolean }} ctx `key`는 지금 기기 저장 키, `localFailed`는 마지막 기기 저장이 실패했는지.
 *   `stopLocal`은 이후 기기 저장을 멈춘다(다시 열기 전에 지금 내용이 원래 키에 다시 저장되지 않게).
 */
export async function resolveSaveConflict(ctx) {
  const kept = ctx.localFailed() ? '' : ' 지금 쓰던 내용은 목록에 "이 기기에만 있음"으로 따로 남겨 둬요.';
  const choice = await ctx.ask(
    '다른 기기에서 먼저 저장했어요. 어느 쪽을 남길까요?\n'
      + `· 다른 기기 내용 불러오기: GitHub에 저장된 내용으로 바꿔요.${kept}\n`
      + '· 내 것으로 덮어쓰기: 다른 기기에서 저장한 내용 위에 지금 내용을 저장해요.',
    // 아무것도 바꾸지 않는 취소가 먼저(초점·Enter가 그쪽으로 간다).
    [
      { label: '취소', value: '' },
      { label: '다른 기기 내용 불러오기', value: 'theirs' },
      { label: '내 것으로 덮어쓰기', value: 'mine' },
    ],
  );
  if (!choice || !ctx.isCurrent()) return;
  const doc = ctx.getDoc();
  const path = doc.draftPath ?? doc.blogPath;
  let latest;
  ctx.setStatus('GitHub에서 최신 내용을 확인하는 중…');
  try {
    latest = await ctx.gh.getFile(ctx.draftsRepo, path);
  } catch (e) {
    if (!ctx.isCurrent()) return;
    if (e instanceof AuthError) return ctx.loseLogin();
    return ctx.setStatus(`최신 내용을 확인하지 못해 아무것도 바꾸지 않았어요. ${failText(e)}`);
  }
  if (!ctx.isCurrent()) return;

  if (choice === 'mine') {
    doc.draftSha = latest?.sha ?? null;
    return ctx.retrySave();
  }
  if (!latest && !doc.blogPath) {
    return ctx.setStatus('다른 기기에서 이 초안을 지웠어요. 불러올 내용이 없어 지금 내용을 그대로 뒀어요. 남기려면 다시 임시저장해서 "내 것으로 덮어쓰기"를 골라 주세요.');
  }
  const backupKey = `new:${crypto.randomUUID().slice(0, 8)}`;
  try {
    local.save(backupKey, { ...doc, meta: { ...doc.meta }, savedAt: new Date().toISOString(), remoteSavedAt: null });
  } catch (e) {
    return ctx.setStatus(`지금 내용을 이 기기에 따로 남기지 못해 불러오지 않았어요. ${e.message}`);
  }
  ctx.stopLocal();
  let notice = '다른 기기 내용을 불러왔어요. 쓰던 내용은 목록에 "이 기기에만 있음"으로 남겨 뒀어요.';
  try {
    // 원래 키의 저장본을 두면 다시 열 때 "이 기기에 더 최근 내용이 있어요"로 또 묻는다.
    local.clear(ctx.key());
  } catch (e) {
    notice += ` ${e.message} 어느 쪽으로 이어 쓸지 물으면 "GitHub 내용"을 골라 주세요.`;
  }
  // 블로그 쪽 경로로 열면 초안이 있으면 초안을, 다른 기기에서 고치던 초안을 지웠으면 공개본을 연다.
  ctx.goTo(editHash(doc.blogPath ? 'blog' : 'drafts', path), notice);
}

/**
 * 출간·삭제 오류가 "고치기 시작한 뒤 공개본이 에디터 밖에서 바뀜"인지 본다.
 * @param {unknown} e `store.publish`·`store.deletePost`가 던진 오류
 * @param {{ blogPath: string|null }} sent 보낸 Doc
 * @returns {boolean} 옮길 자리(같은 날짜·주소)에 다른 글이 있어 난 충돌은 false — 경로가 공개본이 아니라 옮길 자리다.
 */
export function isBlogConflict(e, sent) {
  return e instanceof ConflictError && Boolean(sent.blogPath) && e.path === sent.blogPath;
}

/** 사이트에 지금 공개된 글로 가는 링크(새 탭). 원격 값은 글자로만 넣는다. */
function liveLink(live, path) {
  const meta = { category: live.meta.category ?? '', slug: live.meta.slug || slugFromPath(path) };
  const link = document.createElement('a');
  link.href = postUrl(meta);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = shownUrl(meta);
  return link;
}

/**
 * 고치기 시작한 뒤 공개본이 에디터 밖(git 등)에서 바뀌어 출간·삭제가 막혔을 때 묻고 고른 대로 한다.
 * 다시 열어도 초안의 `base_sha`가 옛 공개본이라 또 부딪히므로, 지금 공개본을 기준으로 다시 잡는다. 블로그에는 쓰지 않는다 —
 * 블로그에 쓰는 것은 그 뒤 사용자가 다시 누르는 수정하기·삭제뿐이다.
 * - 공개본 불러오기: 지금 내용을 새 기기 저장 키(`new:…`, 목록의 "이 기기에만 있음")에 따로 남긴 뒤(못 남기면 그만둔다),
 *   고치던 초안이 있으면 그 자리에 지금 공개본을 임시저장해(`base_sha`가 지금 공개본 sha가 된다) 다시 연다.
 * - 내 것으로 덮어쓰기: 공개본 sha를 새로 읽어 `blogSha`로 삼고 임시저장해 `base_sha`를 바꾼다. 내용은 그대로다.
 *   삭제 중이고 고치던 초안이 없으면 임시저장하지 않는다(지우려는 글에 초안을 새로 만들지 않는다).
 * @param {{ action: 'publish'|'delete', ask: (message: string|(string|Node)[], choices: object[]) => Promise<string>,
 *   getDoc: () => object, key: () => string, store: object, localFailed: () => boolean, setStatus: (text: string) => void,
 *   saveLocal: () => boolean, stopLocal: () => void, saveDraft: () => Promise<boolean>,
 *   goTo: (hash: string, notice: string) => void, loseLogin: () => void, isCurrent: () => boolean }} ctx
 *   `getDoc`은 쓰기 화면이 들고 있는 그 Doc(여기서 `blogSha`를 바꾼다). `saveDraft`는 바뀐 것이 없어도 임시저장하고 됐으면 true
 *   (실패 안내·초안 충돌 창은 그쪽이 띄운다). 나머지는 `resolveSaveConflict`와 같다.
 */
export async function resolveBlogConflict(ctx) {
  const deleting = ctx.action === 'delete';
  const failed = `${deleting ? '지우지' : '출간하지'} 못했어요. 이 글을 고치기 시작한 뒤 공개된 글이 다른 곳에서 바뀌었어요.`;
  const doc = ctx.getDoc();
  const path = doc.blogPath;
  const readLive = async (options) => {
    try {
      return await ctx.store.rebaseOnLive(ctx.getDoc(), options);
    } catch (e) {
      if (!ctx.isCurrent()) return null;
      if (e instanceof AuthError) ctx.loseLogin();
      else ctx.setStatus(`${failed} 지금 공개본을 확인하지 못해 아무것도 바꾸지 않았어요. ${failText(e)}`);
      return null;
    }
  };
  ctx.setStatus(`${failed} 지금 공개본을 확인하는 중…`);
  const live = await readLive();
  if (!live || !ctx.isCurrent()) return;
  ctx.setStatus(`${failed} ${deleting ? '지우지' : '덮어쓰지'} 않았어요.`);
  const kept = ctx.localFailed() ? '' : ' 지금 쓰던 내용은 목록에 "이 기기에만 있음"으로 따로 남겨 둬요.';
  const choice = await ctx.ask(
    [
      `이 글을 고치기 시작한 뒤 공개된 글이 다른 곳(git 등)에서 바뀌었어요. ${deleting ? '지우지' : '덮어쓰지'} 않았어요. 지금 공개본: `,
      liveLink(live, path),
      '\n',
      `· 공개본 불러오기: 지금 공개본으로 다시 열어요. 고친 내용은 그 위에 다시 넣어 주세요.${kept}\n`,
      deleting
        ? '· 내 것으로 덮어쓰기: 지금 공개본을 기준으로 삼아요. 삭제를 다시 누르면 다른 곳에서 바꾼 공개본까지 지워요.'
        : '· 내 것으로 덮어쓰기: 지금 내용은 그대로 두고 지금 공개본을 기준으로 삼아요. 수정하기를 다시 누르면 다른 곳에서 바꾼 공개본 내용은 지금 내용으로 바뀌어 사라져요.',
    ],
    // 아무것도 바꾸지 않는 취소가 먼저(초점·Enter가 그쪽으로 간다).
    [
      { label: '취소', value: '' },
      { label: '공개본 불러오기', value: 'live' },
      { label: '내 것으로 덮어쓰기', value: 'mine' },
    ],
  );
  if (!choice || !ctx.isCurrent()) return;

  if (choice === 'mine') {
    // 고르는 동안 공개본이 또 바뀌었을 수 있어 sha를 다시 읽는다.
    ctx.setStatus('지금 공개본을 다시 확인하는 중…');
    const fresh = await readLive({ keepMine: true });
    if (!fresh || !ctx.isCurrent()) return;
    ctx.getDoc().blogSha = fresh.blogSha;
    const next = deleting ? '삭제를 다시 누르면 지금 공개본을 지워요.' : '수정하기를 다시 누르면 지금 내용으로 덮어써요.';
    if (deleting && !ctx.getDoc().draftPath) {
      ctx.saveLocal();
      return ctx.setStatus(`지금 공개본을 기준으로 바꿨어요. ${next}`);
    }
    if (await ctx.saveDraft() && ctx.isCurrent()) ctx.setStatus(`지금 공개본을 기준으로 바꿔 임시저장했어요. ${next}`);
    return;
  }

  const backupKey = `new:${crypto.randomUUID().slice(0, 8)}`;
  try {
    local.save(backupKey, { ...doc, meta: { ...doc.meta }, savedAt: new Date().toISOString(), remoteSavedAt: null });
  } catch (e) {
    return ctx.setStatus(`지금 내용을 이 기기에 따로 남기지 못해 공개본을 불러오지 않았어요. ${e.message}`);
  }
  if (doc.draftPath) {
    ctx.setStatus('공개본을 불러오는 중…');
    try {
      await ctx.store.saveDraft(live);
    } catch (e) {
      // 불러오지 못했으면 지금 글이 그대로 열려 있으니, 따로 남긴 사본은 겹치기만 한다.
      let dup = '';
      try {
        local.clear(backupKey);
      } catch {
        dup = ' 목록에 같은 내용이 "이 기기에만 있음"으로 한 번 더 보일 수 있어요.';
      }
      if (!ctx.isCurrent()) return;
      if (e instanceof AuthError) return ctx.loseLogin();
      return ctx.setStatus(`공개본을 불러오지 못해 지금 내용을 그대로 뒀어요. ${failText(e)}${dup}`);
    }
    if (!ctx.isCurrent()) return;
  }
  ctx.stopLocal();
  let notice = '지금 공개본을 불러왔어요. 고친 내용은 그 위에 다시 넣어 주세요. 쓰던 내용은 목록에 "이 기기에만 있음"으로 남겨 뒀어요.';
  try {
    // 원래 키의 저장본을 두면 다시 열 때 "이 기기에 더 최근 내용이 있어요"로 또 묻는다.
    local.clear(ctx.key());
  } catch (e) {
    notice += ` ${e.message} 어느 쪽으로 이어 쓸지 물으면 "GitHub 내용"을 골라 주세요.`;
  }
  ctx.goTo(editHash('blog', path), notice);
}
