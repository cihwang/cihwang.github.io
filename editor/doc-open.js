// 쓰기 화면이 글을 열 때: 주소에 맞는 GitHub 내용과 기기 저장본을 받고, 둘이 다르면 어느 쪽으로 이어 쓸지 묻는다.
import { isPostPath } from './post.js';
import { local } from './ui.js';

/** 머리말 키 순서와 상관없이 같은 내용이면 같은 문자열. GitHub에 올라간 내용과 비교하는 데 쓴다. */
export const snapshot = (meta, body) => JSON.stringify([Object.entries(meta).sort(), body]);

/** 기기 저장본에서 Doc 칸만 꺼낸다. 모양이 깨졌으면 null. */
function docFromSaved(saved) {
  if (!saved || typeof saved.body !== 'string' || typeof saved.meta !== 'object' || !saved.meta) return null;
  const { meta, body, draftPath = null, draftSha = null, blogPath = null, blogSha = null } = saved;
  return { meta: { ...meta }, body, draftPath, draftSha, blogPath, blogSha };
}

/**
 * 주소에 맞는 글을 연다. 새 글 주소에 기기 저장 키가 없으면 만들어 주소에 남긴다(새로고침·로그인 풀림 뒤에도 같은 저장본으로 돌아오게).
 * @param {{ name: 'new'|'edit', params: URLSearchParams, store: object }} where `params`: 새 글은 `local`, 편집은 `repo`·`path`
 * @returns {Promise<{ key: string, remote: object|null, saved: object|null, blank?: object }>}
 *   `key`는 기기 저장 키(draftPath, 없으면 blogPath, 새 글은 `new:<랜덤>`). `remote`는 GitHub 내용(새 글이면 null),
 *   `saved`는 기기 저장본(편집은 저장한 그대로, 새 글은 Doc 칸만), `blank`는 새 글의 빈 Doc.
 * @throws {Error} 편집 주소가 글 파일(`posts/…md`, `..`·역슬래시 없음)이 아니거나 GitHub에서 열지 못했을 때
 */
export async function loadDoc({ name, params, store }) {
  if (name === 'new') {
    let key = params.get('local');
    if (!key) {
      key = `new:${crypto.randomUUID().slice(0, 8)}`;
      history.replaceState(null, '', `#/new?local=${encodeURIComponent(key)}`);
    }
    return { key, remote: null, saved: docFromSaved(local.load(key)), blank: store.newDoc('') };
  }
  const repo = params.get('repo') === 'blog' ? 'blog' : 'drafts';
  const path = params.get('path') ?? '';
  // 빈 경로로 Contents API를 부르면 저장소 맨 위 폴더 목록이 와서 글처럼 열린다. posts/ 밖의 파일도 글로 열지 않는다.
  if (!isPostPath(path)) throw new Error(`글 파일 주소가 아니에요. (${path || '빈 주소'})`);
  const remote = await store.open({ repo, path });
  const key = remote.draftPath ?? remote.blogPath;
  return { key, remote, saved: local.load(key) };
}

/**
 * GitHub 내용과 기기 저장본 중 어느 쪽으로 이어 쓸지 정한다. 기기에 올리지 않은 다른 내용이 있을 때만 묻는다.
 * @param {object} remote GitHub에서 연 Doc
 * @param {object|null} saved 같은 키의 기기 저장본(`savedAt`·`remoteSavedAt` 포함)
 * @param {(message: string, choices: object[]) => Promise<string>} ask 묻기 창
 * @returns {Promise<{ doc: object, dropLocal: boolean }>} `dropLocal`: GitHub 쪽을 골라 기기 저장본을 덮어야 함
 */
export async function chooseDoc(remote, saved, ask) {
  const savedDoc = docFromSaved(saved);
  const unsynced = savedDoc && (saved.savedAt ?? '') > (saved.remoteSavedAt ?? '')
    && snapshot(savedDoc.meta, savedDoc.body) !== snapshot(remote.meta, remote.body);
  if (!unsynced) return { doc: remote, dropLocal: false };
  const when = saved.savedAt ? ` (${new Date(saved.savedAt).toLocaleString('ko-KR')} 저장)` : '';
  const moved = savedDoc.draftSha !== remote.draftSha || savedDoc.blogSha !== remote.blogSha;
  const choice = await ask(
    `이 기기에 더 최근 내용이 있어요${when}. ${moved ? 'GitHub 쪽도 그 뒤에 다른 곳에서 바뀌었어요. ' : ''}`
      + '어느 쪽으로 이어 쓸까요? GitHub 내용을 고르면 이 기기 내용은 지워져요.',
    // 지우지 않는 쪽이 먼저(초점·Enter가 그쪽으로 간다).
    [{ label: '이 기기 내용', value: 'local', primary: true }, { label: 'GitHub 내용', value: 'remote' }],
  );
  if (choice === 'remote') return { doc: remote, dropLocal: true };
  // 창을 그냥 닫아도 지우지 않는 쪽(기기 내용)으로 간다. GitHub가 그 뒤에 바뀌었으면 기기 저장본이 알던 sha를 그대로 둬서,
  // 다음 저장이 다른 기기의 커밋을 덮지 않고 ConflictError가 나게 한다.
  const shas = moved ? { draftSha: savedDoc.draftSha, blogSha: savedDoc.blogSha } : {};
  return { doc: { ...remote, meta: savedDoc.meta, body: savedDoc.body, ...shas }, dropLocal: false };
}
