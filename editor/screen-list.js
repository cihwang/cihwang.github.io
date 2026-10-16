// 임시글 목록 화면(`#/`): 초안 저장소·공개 저장소 초안·이 기기에만 있는 새 글을 보여 주고 이어 쓰기·삭제를 한다.
import { BLOG_REPO } from './config.js';
import { AuthError } from './github.js';
import { $, local, editHash, failText, cloneTemplate, mount, addNotice, fetchLive } from './ui.js';

const KIND_LABEL = { editing: '고치는 중', 'public-draft': '공개 저장소에 있음', local: '이 기기에만 있음' };
const relative = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];

/** ISO 시각을 "3시간 전" 같은 말로. 1분 안이면 "방금". */
function relativeTime(iso) {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  const unit = UNITS.find(([, size]) => Math.abs(sec) >= size);
  return unit ? relative.format(Math.round(sec / unit[1]), unit[0]) : '방금';
}

/** 이 기기에만 있고 GitHub에 올린 적 없는 새 글(`new:` 키)들. 창을 닫았다 열어도 이어 쓸 수 있게 목록에 같이 보여 준다. */
function localOnlyDrafts() {
  return local.keys().filter((k) => k.startsWith('new:')).map((key) => {
    const saved = local.load(key);
    return saved && { key, kind: 'local', title: saved.meta?.title ?? '', category: saved.meta?.category ?? '', updated: saved.savedAt ?? null };
  }).filter(Boolean);
}

function draftRow(draft, { onOpen, onDelete }) {
  const row = cloneTemplate('draft-row');
  const name = draft.title || '(제목 없음)';
  $(row, 'title').textContent = name;
  $(row, 'cat').textContent = draft.category || '카테고리 없음';
  if (draft.updated) {
    const time = $(row, 'time');
    time.dateTime = draft.updated;
    time.textContent = relativeTime(draft.updated);
    time.title = new Date(draft.updated).toLocaleString('ko-KR');
  }
  if (KIND_LABEL[draft.kind]) {
    const badge = $(row, 'kind');
    badge.textContent = KIND_LABEL[draft.kind];
    badge.hidden = false;
  }
  const open = $(row, 'open');
  const del = $(row, 'delete');
  open.setAttribute('aria-label', `${name} 이어 쓰기`);
  del.setAttribute('aria-label', `${name} 삭제`);
  open.addEventListener('click', () => onOpen(draft));
  del.addEventListener('click', () => onDelete(draft, row));
  return row;
}

function deleteQuestion(draft) {
  const name = draft.title || '(제목 없음)';
  if (draft.kind === 'public-draft') return `"${name}" 글을 공개 저장소에서 지울까요? 블로그 저장소에 커밋이 하나 생기고, 되돌릴 수 없어요.`;
  if (draft.kind === 'editing') return `"${name}"의 고치던 내용을 지울까요? 사이트에 공개된 글은 그대로예요.`;
  if (draft.kind === 'local') return `"${name}" 글을 이 기기에서 지울까요? GitHub에 올린 적 없는 글이라 되돌릴 수 없어요.`;
  return `"${name}" 초안을 지울까요? 되돌릴 수 없어요.`;
}

/**
 * 임시글 목록을 그린다.
 * @param {{ session: { gh: object, store: object, draftsRepo: string }, isCurrent: () => boolean,
 *   ask: (message: string, choices: object[]) => Promise<string>, loseLogin: () => void, logout: () => void, notice?: string|null }} ctx
 *   `isCurrent`는 이 화면이 아직 떠 있는지(늦게 끝난 작업이 떠난 화면을 건드리지 않게), `notice`는 맨 위에 띄울 안내.
 * @returns {() => void} 화면을 떠날 때 부를 정리 함수
 */
export function showList({ session, isCurrent, ask, loseLogin, logout, notice }) {
  const root = mount('list');
  const status = $(root, 'status');
  const list = $(root, 'drafts');
  const { store, gh, draftsRepo } = session;
  const failed = (e, what) => {
    if (!isCurrent()) return;
    if (e instanceof AuthError) return loseLogin();
    status.textContent = `${what} ${failText(e)}`;
  };
  if (notice) addNotice(root, notice);
  $(root, 'logout').addEventListener('click', logout);

  async function openDraft(draft) {
    if (draft.kind === 'local') return void (location.hash = `#/new?local=${encodeURIComponent(draft.key)}`);
    if (draft.kind !== 'public-draft') return void (location.hash = editHash('drafts', draft.path));
    const choice = await ask('이 글은 공개 저장소에 있어서 누구나 GitHub에서 읽을 수 있어요. 비공개 초안 저장소로 옮긴 뒤 이어 쓸까요?', [
      { label: '취소', value: '' },
      { label: '옮기고 이어 쓰기', value: 'move', primary: true },
    ]);
    if (choice !== 'move' || !isCurrent()) return;
    status.textContent = '초안 저장소로 옮기는 중…';
    try {
      await store.moveToDrafts(draft.path);
      if (isCurrent()) location.hash = editHash('drafts', draft.path);
    } catch (e) {
      failed(e, '옮기지 못했어요.');
    }
  }

  async function deleteDraft(draft, row) {
    const choice = await ask(deleteQuestion(draft), [{ label: '취소', value: '' }, { label: '삭제', value: 'delete', primary: true }]);
    if (choice !== 'delete' || !isCurrent()) return;
    status.textContent = '지우는 중…';
    try {
      if (draft.kind === 'public-draft') {
        // 목록은 sha를 들고 있지 않아 지금 공개본을 읽어 그 sha로 지운다(초안 삭제와 같다).
        const file = await gh.getFile(BLOG_REPO, draft.path);
        if (file) await store.deletePost(draft.path, file.sha);
      } else if (draft.kind !== 'local') {
        const file = await gh.getFile(draftsRepo, draft.path);
        if (file) await store.deleteDraft(draft.path, file.sha);
      }
    } catch (e) {
      return failed(e, '지우지 못했어요.');
    }
    // 원격을 지운 뒤에만 기기 저장본을 지운다. 순서가 반대면 원격 삭제 실패 때 쓰던 내용이 사라진다.
    let note = '지웠어요.';
    try {
      local.clear(draft.key ?? draft.path);
    } catch (e) {
      if (draft.kind === 'local') return void (status.textContent = `지우지 못했어요. ${e.message}`);
      note = `GitHub에서는 지웠지만 ${e.message}`;
    }
    row.remove();
    status.textContent = note;
  }

  const actions = { onOpen: openDraft, onDelete: deleteDraft };
  list.append(...localOnlyDrafts().map((d) => draftRow(d, actions)));

  (async () => {
    // 카테고리는 다른 기기에서 바뀌었을 수 있어 화면을 열 때마다 site.json을 새로 읽는다.
    const [live, site] = await Promise.allSettled([fetchLive(), store.getSite()]);
    if (!isCurrent()) return;
    if (site.status === 'rejected' && site.reason instanceof AuthError) return loseLogin();
    if (live.status === 'rejected') addNotice(root, `${live.reason.message} "고치는 중" 표시가 빠질 수 있어요.`);
    if (site.status === 'rejected') addNotice(root, `카테고리 목록을 불러오지 못했어요. ${site.reason.message}`);
    try {
      const drafts = await store.listDrafts(live.value ?? []);
      if (!isCurrent()) return;
      list.append(...drafts.map((d) => draftRow(d, actions)));
      status.textContent = list.children.length ? '' : '임시글이 없어요.';
    } catch (e) {
      failed(e, '임시글을 불러오지 못했어요.');
    }
  })();
  return () => {};
}
