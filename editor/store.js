/**
 * 임시저장·출간·삭제·카테고리 흐름. 화면은 이 모듈만 부르고, GitHub 오류(AuthError·ConflictError·GitHubError)는
 * 바꾸지 않고 그대로 올려 화면이 무엇을 보여 줄지 정하게 한다. 쓰던 글을 잃거나 남의 저장을 덮지 않는 것이 목표다.
 */
import { slugFromPath } from '../markdown.js';
import { BLOG_REPO } from './config.js';
import { utf8ToBase64 } from './github.js';
import { mediaFileName, mediaRefs } from './media.js';
import {
  parsePost, serializePost, slugFromTitle, postPath,
  validateDraft, validatePublish, validateCategoryName, recategorize,
} from './post.js';

const SITE_PATH = 'site.json';
const pad = (n) => String(n).padStart(2, '0');

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `posts/` 아래 `.md`이고, 어느 조각도 `_`로 시작하지 않는 파일(템플릿·도움말 제외). */
function isPostFile(entry) {
  return entry.type === 'blob' && entry.path.startsWith('posts/') && entry.path.endsWith('.md')
    && !entry.path.split('/').some((s) => s.startsWith('_'));
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // 한 번에 펼치면 큰 사진에서 인자 개수 한도를 넘으므로 조각으로 나눈다.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const withoutDraft = ({ draft, ...rest }) => rest;
const titleOf = (meta) => meta.title ?? '';

/**
 * 저장 흐름 객체를 만든다. `Doc` 모양: `{ meta, body, draftPath, draftSha, blogPath, blogSha }`,
 * `blogPath`가 있으면 공개된 글을 고치는 중이다. 모든 메서드는 GitHub 오류를 그대로 던진다.
 * `site.json`은 `getSite()`가 읽어 기억해 두고, 저장 전 검사(`saveDraft`·`publish`·카테고리)는 그 목록으로 GitHub 호출 없이 한다.
 * @param {{ gh: object, draftsRepo: string, blogRepo?: string, today?: () => string, now?: () => Date }} options
 *   `gh`는 `createGitHub()` 클라이언트, 저장소는 `'owner/name'`. `today`는 새 글 날짜(기본: 기기 지역 날짜 YYYY-MM-DD),
 *   `now`는 사진 파일 이름의 시각(기본: 지금).
 */
export function createStore({ gh, draftsRepo, blogRepo = BLOG_REPO, today = localToday, now = () => new Date() }) {
  let site = null;

  async function categories() {
    return (site ?? await getSite()).categories;
  }

  async function readPost(repo, path) {
    const file = await gh.getFile(repo, path);
    return file && { ...parsePost(file.text), text: file.text, sha: file.sha };
  }

  /**
   * 임시글 목록: 초안 저장소의 글(`new`·`editing`)과 블로그 저장소에만 있는 `draft: true` 글(`public-draft`).
   * @param {{ path: string }[]} livePosts 사이트 `posts.json`의 글들(지금 공개된 것)
   * @returns {Promise<{ repo: 'drafts'|'blog', path: string, title: string, category: string, updated: string|null,
   *   kind: 'new'|'editing'|'public-draft' }[]>} `updated`(마지막 커밋 ISO 시각) 내림차순, 모르면 맨 뒤.
   */
  async function listDrafts(livePosts) {
    const live = new Set(livePosts.map((p) => p.path));
    const entry = async (repo, path, kind, post) => ({
      repo: repo === draftsRepo ? 'drafts' : 'blog', path, title: titleOf(post.meta), category: post.meta.category ?? '',
      updated: await gh.lastCommitDate(repo, path), kind,
    });
    const [draftTree, blogTree] = await Promise.all([gh.listTree(draftsRepo), gh.listTree(blogRepo)]);
    const drafts = draftTree.filter(isPostFile).map(async ({ path }) => {
      const post = await readPost(draftsRepo, path);
      return post && entry(draftsRepo, path, live.has(path) ? 'editing' : 'new', post);
    });
    const blog = blogTree.filter((e) => isPostFile(e) && !live.has(e.path)).map(async ({ path }) => {
      const post = await readPost(blogRepo, path);
      return post?.meta.draft === 'true' ? entry(blogRepo, path, 'public-draft', post) : null;
    });
    const list = (await Promise.all([...drafts, ...blog])).filter(Boolean);
    return list.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }

  /**
   * 글을 연다. 블로그 경로를 열 때 초안 저장소에 같은 경로가 있으면(고치는 중) 그 내용을 열고 `blogSha`만 블로그에서 채운다.
   * 초안을 열 때 블로그에 같은 경로가 있으면 `blogPath`·`blogSha`를 채운다.
   * @param {{ repo: 'drafts'|'blog', path: string }} where
   * @throws {Error} 연 쪽 저장소에 파일이 없을 때
   */
  async function open({ repo, path }) {
    const [draft, blog] = await Promise.all([readPost(draftsRepo, path), readPost(blogRepo, path)]);
    const main = repo === 'blog' ? (draft ?? blog) : draft;
    if (!main || (repo === 'blog' && !blog)) throw new Error(`글을 찾지 못했어요. (${repo}: ${path})`);
    return {
      meta: main.meta, body: main.body,
      draftPath: draft ? path : null, draftSha: draft?.sha ?? null,
      blogPath: blog ? path : null, blogSha: blog?.sha ?? null,
    };
  }

  /** 빈 새 글. GitHub를 부르지 않는다. */
  function newDoc(category) {
    return {
      meta: { title: '', category, date: today(), draft: 'true' }, body: '',
      draftPath: null, draftSha: null, blogPath: null, blogSha: null,
    };
  }

  /**
   * 초안 저장소에 임시저장한다(`draft: true`를 붙여). 경로는 `draftPath`, 없으면 `blogPath`, 없으면 날짜·slug로 만든다.
   * 공개본은 건드리지 않는다.
   * @returns {Promise<object>} 새 `draftPath`·`draftSha`가 든 Doc
   * @throws {Error} 제목·카테고리 검사 실패(GitHub 호출 없음). 새 글의 경로에 공개된 글이 이미 있으면(쓰기 전).
   *   그 사이 다른 기기가 저장했으면 `ConflictError`.
   */
  async function saveDraft(doc) {
    const errors = validateDraft(doc.meta, await categories());
    if (errors.length) throw new Error(`임시저장할 수 없어요: ${errors.join(', ')}`);
    const meta = { ...doc.meta, draft: 'true' };
    const path = doc.draftPath ?? doc.blogPath ?? postPath(meta.date, meta.slug || slugFromTitle(meta.title));
    // 새 글이 공개된 다른 글과 같은 경로를 잡으면, 나중에 그 글을 "고치는 중"으로 보고 출간 때 덮어쓴다.
    if (!doc.draftPath && !doc.blogPath && await gh.getFile(blogRepo, path)) {
      throw new Error(`같은 날짜·주소의 공개된 글이 이미 있어요. 주소(slug)를 바꿔 주세요. (${path})`);
    }
    const { sha } = await gh.putFile(draftsRepo, path, {
      text: serializePost(meta, doc.body), sha: doc.draftSha ?? undefined, message: `초안: ${titleOf(meta)}`,
    });
    return { ...doc, meta, draftPath: path, draftSha: sha };
  }

  /**
   * 사진·영상을 초안 저장소 `media/`에 올린다. 출간할 때 본문이 가리키는 것만 블로그로 복사된다.
   * @param {string} rand 같은 초의 이름 충돌을 피할 무작위 문자열
   * @returns {Promise<string>} 올린 경로 `media/…`(본문에는 `../media/…`로 쓴다)
   */
  async function uploadMedia(blob, originalName, rand) {
    const path = mediaFileName(originalName, now(), rand);
    await gh.putFile(draftsRepo, path, { base64: await blobToBase64(blob), message: `사진: ${path}` });
    return path;
  }

  /**
   * 블로그 저장소에 한 커밋으로 출간·수정하고, 그 뒤에만 초안을 지운다.
   * 블로그에 이미 같은 내용이 있으면(커밋 뒤 초안 삭제가 실패한 다시 누르기) 커밋을 건너뛰고 초안만 지운다.
   * slug·날짜를 바꾸면 `postPath(date, slug)`로 옮기고 옛 경로를 같은 커밋에서 지운다. 사진은 블로그에 없는 것만 복사한다.
   * @param {{ path: string, cat: string, slug: string }[]} livePosts 같은 카테고리 slug 겹침 검사용
   * @returns {Promise<{ path: string, alreadyPublished: boolean }>} `path`는 블로그의 글 경로
   * @throws {Error} 출간 검사 오류, 또는 본문의 사진이 어느 저장소에도 없을 때(쓰기 전, 초안은 남는다). 공개본이 그 사이 바뀌었거나 대상 자리에 다른 글이 있으면 `ConflictError`.
   *   초안 삭제가 실패하면 그 오류를 던진다(블로그 커밋은 이미 됐고, 다시 부르면 초안 삭제만 한다).
   */
  async function publish(doc, livePosts) {
    const meta = withoutDraft(doc.meta);
    const text = serializePost(meta, doc.body);
    const slug = meta.slug || slugFromTitle(titleOf(meta));
    const original = doc.blogPath ? await readPost(blogRepo, doc.blogPath) : null;
    // 원본이 없으면(새 글, 또는 옮긴 뒤 다시 누름) 날짜·slug로 정한 자리가 대상이다.
    const keepPath = original && (original.meta.slug || slugFromPath(doc.blogPath)) === slug && (original.meta.date ?? '') === (meta.date ?? '');
    const target = keepPath ? doc.blogPath : postPath(meta.date, slug);
    const existing = target === doc.blogPath ? original : await readPost(blogRepo, target);

    if (existing?.text !== text) {
      const { errors } = validatePublish(meta, doc.body, { categories: await categories(), livePosts, ownPath: doc.blogPath });
      if (errors.length) throw new Error(`출간할 수 없어요: ${errors.join(', ')}`);
      const files = [{ path: target, base64: utf8ToBase64(text) }, ...await mediaToCopy(doc.body)];
      const expect = doc.blogPath ? { [doc.blogPath]: doc.blogSha } : {};
      // 옮길 자리에 다른 글(다른 카테고리의 같은 날짜·slug)이 있으면 덮지 않는다.
      if (target !== doc.blogPath) expect[target] = null;
      await gh.commitFiles(blogRepo, {
        message: `${doc.blogPath ? '수정' : '글'}: ${titleOf(meta)}`,
        files,
        deletes: doc.blogPath && target !== doc.blogPath ? [doc.blogPath] : [],
        expect,
      });
    }
    if (doc.draftPath) await gh.deleteFile(draftsRepo, doc.draftPath, doc.draftSha, `출간: ${titleOf(meta)}`);
    return { path: target, alreadyPublished: existing?.text === text };
  }

  /**
   * 본문이 가리키는 사진 중 블로그에 없고 초안 저장소에 있는 것을 `{ path, base64 }`로.
   * 어디에도 없는 사진(아직 올리는 중 등)이 있으면 던진다 — 깨진 그림으로 출간되면 같은 내용 다시 누르기로는 고쳐지지 않는다.
   */
  async function mediaToCopy(body) {
    const refs = mediaRefs(body);
    if (!refs.length) return [];
    const [blogTree, draftTree] = await Promise.all([gh.listTree(blogRepo), gh.listTree(draftsRepo)]);
    const inBlog = new Set(blogTree.map((e) => e.path));
    const draftSha = new Map(draftTree.map((e) => [e.path, e.sha]));
    const nowhere = refs.filter((p) => !inBlog.has(p) && !draftSha.has(p));
    if (nowhere.length) throw new Error(`본문의 사진을 찾지 못해 출간하지 않았어요. 사진을 다시 올려 주세요. (${nowhere.join(', ')})`);
    const toCopy = refs.filter((p) => !inBlog.has(p));
    return Promise.all(toCopy.map(async (path) => ({ path, base64: await gh.getBlobBase64(draftsRepo, draftSha.get(path)) })));
  }

  /** 초안을 지운다. `sha`가 그 사이 바뀌었으면(다른 기기 저장) GitHub 오류. 이미 없으면 성공. */
  async function deleteDraft(path, sha) {
    await gh.deleteFile(draftsRepo, path, sha, `삭제: ${path}`);
  }

  /** 공개된 글을 블로그에서 한 커밋으로 지운다. 사진·초안 저장소의 고치던 내용은 남긴다. 이미 없으면 아무것도 안 한다. */
  async function deletePost(path) {
    const post = await readPost(blogRepo, path);
    if (!post) return;
    await gh.commitFiles(blogRepo, {
      message: `삭제: ${titleOf(post.meta)}`, files: [], deletes: [path], expect: { [path]: post.sha },
    });
  }

  /**
   * 블로그의 `public-draft`를 초안 저장소 같은 경로로 옮기고 블로그에서는 한 커밋으로 지운다.
   * 초안 저장소에 이미 같은 내용이 있으면(앞서 반쯤 옮김) 그것을 쓰고, 다른 내용이 있으면 덮지 않고 `ConflictError`.
   * @returns {Promise<object>} 초안으로 연 Doc(`blogPath`는 null)
   * @throws {Error} 블로그에 그 글이 없을 때
   */
  async function moveToDrafts(path) {
    const post = await readPost(blogRepo, path);
    if (!post) throw new Error(`공개 저장소에서 글을 찾지 못했어요. (${path})`);
    const moved = await gh.getFile(draftsRepo, path);
    const draftSha = moved?.text === post.text
      ? moved.sha
      : (await gh.putFile(draftsRepo, path, { text: post.text, message: `초안으로 옮기기: ${titleOf(post.meta)}` })).sha;
    await gh.commitFiles(blogRepo, {
      message: `초안으로 옮기기: ${titleOf(post.meta)}`, files: [], deletes: [path], expect: { [path]: post.sha },
    });
    return { meta: post.meta, body: post.body, draftPath: path, draftSha, blogPath: null, blogSha: null };
  }

  /**
   * 블로그 `site.json`을 읽어 기억해 둔다.
   * @returns {Promise<{ site: string, categories: string[], sha: string }>}
   * @throws {Error} `site.json`이 없을 때
   */
  async function getSite() {
    const file = await gh.getFile(blogRepo, SITE_PATH);
    if (!file) throw new Error(`블로그 저장소에 ${SITE_PATH}가 없어요.`);
    const json = JSON.parse(file.text);
    site = { json, sha: file.sha, categories: json.categories };
    return { site: json.site, categories: json.categories, sha: file.sha };
  }

  const siteText = (json, categories) => JSON.stringify({ ...json, categories }, null, 2) + '\n';

  /** 라이브 글의 카테고리별 수. GitHub를 부르지 않는다. 글이 없는 카테고리는 키가 없다. */
  function countByCategory(livePosts) {
    const counts = {};
    for (const p of livePosts) counts[p.cat] = (counts[p.cat] ?? 0) + 1;
    return counts;
  }

  /**
   * 카테고리를 목록 끝에 더해 `site.json`을 한 커밋으로 올린다.
   * @param {string} name 앞뒤 공백은 뗀다
   * @returns {Promise<string[]>} 새 카테고리 목록
   * @throws {Error} 이름 규칙 위반(GitHub 호출 없음). `site.json`이 그 사이 바뀌었으면 `ConflictError`.
   */
  async function addCategory(name) {
    if (!site) await getSite();
    const current = site;
    const errors = validateCategoryName(name, current.categories);
    if (errors.length) throw new Error(`카테고리를 만들 수 없어요: ${errors.join(', ')}`);
    const trimmed = name.trim();
    const next = [...current.categories, trimmed];
    await gh.commitFiles(blogRepo, {
      message: `카테고리 추가: ${trimmed}`,
      files: [{ path: SITE_PATH, base64: utf8ToBase64(siteText(current.json, next)) }],
      deletes: [],
      expect: { [SITE_PATH]: current.sha },
    });
    site = null;
    return next;
  }

  /** 저장소의 글 중 category가 `from`인 것을 `to`로 바꾼 `{ files, expect }`. */
  async function recategorizedPosts(repo, from, to) {
    const tree = await gh.listTree(repo);
    const changed = await Promise.all(tree.filter(isPostFile).map(async ({ path }) => {
      const file = await gh.getFile(repo, path);
      const text = file ? recategorize(file.text, from, to) : null;
      return text === null ? null : { path, text, sha: file.sha };
    }));
    const hits = changed.filter(Boolean);
    return {
      files: hits.map((h) => ({ path: h.path, base64: utf8ToBase64(h.text) })),
      expect: Object.fromEntries(hits.map((h) => [h.path, h.sha])),
    };
  }

  /**
   * 카테고리 이름을 바꾼다: 블로그(글 + `site.json`) 한 커밋, 그다음 초안 저장소 한 커밋.
   * 블로그 커밋이 실패하면 초안 저장소는 건드리지 않고 그 오류를 그대로 던진다.
   * @returns {Promise<{ posts: number, drafts: number }>} 바꾼 공개 글·초안 수
   * @throws {Error} 이름 규칙 위반이나 없는 `from`(GitHub 호출 없음). 초안 쪽만 실패하면 "블로그는 바뀜, 초안 N편은 그대로"
   *   메시지의 Error(원래 오류는 `cause`).
   */
  async function renameCategory(from, to) {
    const cats = await categories();
    const name = to.trim();
    if (!cats.includes(from)) throw new Error(`없는 카테고리예요. (${from})`);
    const errors = validateCategoryName(name, cats);
    if (errors.length) throw new Error(`카테고리 이름을 바꿀 수 없어요: ${errors.join(', ')}`);
    const message = `카테고리 이름 바꾸기: ${from} → ${name}`;

    const blog = await recategorizedPosts(blogRepo, from, name);
    // 기억해 둔 것이 아니라 지금 site.json을 읽어 그 sha를 expect에 건다.
    await getSite();
    const renamed = site.categories.map((c) => (c === from ? name : c));
    await gh.commitFiles(blogRepo, {
      message,
      files: [...blog.files, { path: SITE_PATH, base64: utf8ToBase64(siteText(site.json, renamed)) }],
      deletes: [],
      expect: { ...blog.expect, [SITE_PATH]: site.sha },
    });
    site = null;

    let pending = null;
    try {
      const drafts = await recategorizedPosts(draftsRepo, from, name);
      pending = drafts.files.length;
      if (pending) await gh.commitFiles(draftsRepo, { message, files: drafts.files, deletes: [], expect: drafts.expect });
    } catch (e) {
      const left = pending === null ? '초안은 그대로' : `초안 ${pending}편은 그대로`;
      throw new Error(`블로그는 바뀜, ${left}예요. 초안의 카테고리는 다시 시도하거나 직접 고쳐 주세요. (${e.message})`, { cause: e });
    }
    return { posts: blog.files.length, drafts: pending };
  }

  return {
    listDrafts, open, newDoc, saveDraft, uploadMedia, publish, deleteDraft, deletePost, moveToDrafts,
    getSite, countByCategory, addCategory, renameCategory,
  };
}
