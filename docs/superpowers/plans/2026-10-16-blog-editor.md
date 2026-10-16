# 블로그 글쓰기 에디터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이트 안의 `write.html`에서 PC·폰 어디서든 velog처럼 글을 쓰고·임시저장(비공개 초안 저장소)·출간·수정할 수 있게 한다.

**Architecture:** 서버 없이 브라우저가 GitHub REST API를 직접 부른다. 초안은 비공개 초안 저장소에, 출간본은 블로그 저장소 `posts/`·`media/`에 둔다. 출간은 Git Data API로 블로그 저장소에 커밋 하나를 만든다. 미리보기는 `build.js`와 같은 마크다운 모듈(`markdown.js`)을 브라우저에서 import map으로 불러 그린다. 순수 로직(`editor/*.js`)은 `node --test`로 검사하고, 화면은 실제 브라우저에서 확인한다.

**Tech Stack:** 순수 JS(ESM, 번들러 없음), 기존 의존성 그대로(marked 18.1.1 외 `package.json` 고정 버전), Node 24 `node:test`, GitHub REST API(`X-GitHub-Api-Version: 2022-11-28`).

**Spec:** `docs/superpowers/specs/2026-10-16-blog-editor-design.md`

## Global Constraints

- 새 npm 의존성 없음. 필요해 보이면 멈추고 사용자에게 묻는다(스펙 6장).
- 외부 CDN 스크립트를 `write.html`에 넣지 않는다. GoatCounter도 넣지 않는다(스펙 6장).
- 블로그 저장소 `cihwang/cihwang.github.io`, 사이트 `https://cihwang.github.io/`. 초안 저장소 이름은 사용자가 로그인 화면에서 넣는다.
- 토큰: fine-grained PAT, 두 저장소의 Contents 읽기·쓰기만. 브라우저 `localStorage`에만 둔다.
- 초안 저장소가 **비공개가 아니면** 로그인을 거부한다(스펙 5-8: 초안은 남에게 보이지 않아야 한다).
- 바꾸는 작업(글·사진·카테고리)은 모두 토큰으로 GitHub에 쓰는 것으로만 한다. 사이트·`posts.json`·`localStorage`만으로 무언가 바뀌는 길을 만들지 않는다(스펙 5-7 "모든 작업은 나만").
- 카테고리 원본은 블로그 저장소 `site.json`. 이름 규칙: 앞뒤 공백 제거, 1~20자, `/ # ? %`와 맨 앞 `_` 금지, 중복 금지(스펙 5-9).
- 자동 저장 10초(velog와 같음), `Ctrl/Cmd+S` = 임시저장, 사진 가로 2000px 이하로 줄이기.
- 출간된 글 파일 이름 `posts/YYYY-MM-DD-<slug>.md`. 머리말 키 `title`·`category`·`date`·`slug`·`draft`(build.js 규칙). `build.js` 검사 규칙은 바꾸지 않는다.
- 화면 문구는 한국어 해요체. 글꼴 Pretendard·D2Coding, 색은 `styles.css`의 토큰만 쓴다(`--bg`, `--ink`, `--muted`, `--tick`, `--accent` 등).
- 모든 단언에 메시지를 붙인다(`assert.equal(actual, expected, '왜')`). 단언을 약하게 하거나 건너뛰지 않는다.
- 커밋·푸시는 사용자 확인을 받고 한다. 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다. 형식 `feat|fix|refactor|chore|test: <요약>`.
- 저장 실패를 성공처럼 보이게 하지 않는다. 실패하면 이유를 보여 주고 기기 안 저장본을 남긴다(스펙 5-5).

## Review Focus

1. **만료·취소된 토큰(401/403)으로 저장할 때** — 쓰던 글이 기기에 그대로 남고 "다시 로그인" 안내가 떠야 한다. → Task 5·6 테스트.
2. **한글·이모지·CRLF가 섞인 글의 왕복** — GitHub에 올렸다 받아도 글자가 깨지거나 줄바꿈이 바뀌지 않아야 한다. → Task 3·5 테스트.
3. **같은 초안을 두 기기(두 탭)에서 저장** — 나중 저장이 앞의 것을 조용히 덮지 않고 충돌로 알려야 한다. → Task 6 테스트.
4. **출간 커밋은 됐는데 초안 삭제가 실패한 뒤 다시 출간** — 글·사진이 겹치거나 커밋이 또 생기지 않고 초안만 지워져야 한다. → Task 6 테스트.
5. **폰에서 화면 키보드가 열렸을 때** — 서식 단추와 저장 막대가 키보드에 가려지지 않아야 한다. → Task 8 브라우저 확인 항목.

---

### Task 1: 마크다운 모듈을 build.js와 브라우저가 같이 쓰게 빼기

**Files:**
- Create: `markdown.js`
- Modify: `build.js` (마크다운 설정·`splitFrontMatter`·slug 계산을 `markdown.js`에서 가져온다, `posts.json` 글마다 `path` 추가)
- Modify: `serve.py:22-24` (`_latest_source_mtime`의 감시 대상에 `markdown.js` 추가)
- Modify: `package.json` (`"test": "node --test"`)
- Test: `tests/markdown.test.js`

**Interfaces:**
- Produces (모두 `markdown.js`의 named export, Node·브라우저 공용, `node:` 모듈 금지):
  - `splitFrontMatter(text: string): { meta: Record<string,string>, body: string }` — build.js의 것을 그대로 옮긴다.
  - `renderMarkdown(body: string): string` — `resetHeadings()` 후 `body.trim() ? marked.parse(body) : ''`. build.js의 marked 설정(highlight·각주·제목 id `h-`·KaTeX·이모지·그림 renderer) 그대로.
  - `slugFromPath(path: string): string` — 마지막 `/` 뒤 이름에서 `.md`와 앞의 `YYYY-MM-DD-`를 뗀다(build.js와 같은 규칙).
- `posts.json`의 글 항목에 `path`(`posts/…md`, 구분자는 항상 `/`)를 남긴다. 지금 지우는 `file` 대신이다.

- [ ] **Step 1: 리팩터 전 기준 저장** — `node build.js --drafts && cp posts.json /tmp/posts.before.json` (Windows는 scratch 폴더).
- [ ] **Step 2: 실패하는 테스트 작성** `tests/markdown.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, renderMarkdown, slugFromPath } from '../markdown.js';

test('머리말과 본문을 나눈다(CRLF 포함)', () => {
  const { meta, body } = splitFrontMatter('---\r\ntitle: "가: 나"\r\ncategory: 공부\r\n---\r\n본문');
  assert.equal(meta.title, '가: 나', '첫 콜론에서만 나누고 따옴표는 벗긴다');
  assert.equal(meta.category, '공부', 'CRLF 머리말도 읽는다');
  assert.equal(body, '본문', '머리말 뒤가 본문');
});
test('제목 id는 글마다 새로 센다', () => {
  assert.match(renderMarkdown('## 가\n'), /id="h-가"/, '첫 렌더');
  assert.match(renderMarkdown('## 가\n'), /id="h-가"/, '두 번째 렌더도 -1이 붙지 않아야 한다(resetHeadings)');
});
test('빈 본문은 빈 문자열', () => assert.equal(renderMarkdown('  \n'), '', 'build.js와 같은 규칙'));
test('그림 문법의 ../media/는 media/로', () =>
  assert.match(renderMarkdown('![a](../media/x.png)'), /src="media\/x.png"/, '사이트 기준 경로'));
test('slug는 파일 이름에서 날짜를 뗀 것', () => {
  assert.equal(slugFromPath('posts/2026-10-13-agentforce-coworker.md'), 'agentforce-coworker', '날짜 접두어 제거');
  assert.equal(slugFromPath('posts/예시/공부-01.md'), '공부-01', '날짜 없는 이름은 그대로');
});
```

- [ ] **Step 3: 실패 확인** — `npm test` → `Cannot find module '../markdown.js'`.
- [ ] **Step 4: `markdown.js` 작성, `build.js`가 그것을 쓰게 바꾸기** — build.js에서 marked 생성 블록·`splitFrontMatter`·slug 한 줄을 지우고 import로 바꾼다. 도움말 렌더도 `renderMarkdown`을 쓴다. `path: where.split(/[\\/]/).join('/')`를 남기고 `delete p.file`은 그대로 둔다.
- [ ] **Step 5: 테스트 통과 확인** — `npm test` → 5개 PASS.
- [ ] **Step 6: 출력이 그대로인지 확인** — `node build.js --drafts`를 다시 돌린 뒤 node 한 줄로 `/tmp/posts.before.json`과 비교한다. 글마다 `path`만 늘고 `html`·`slug`·순서는 같아야 한다. 다르면 멈추고 원인을 찾는다.
- [ ] **Step 7: 커밋(사용자 확인 후)** — `refactor: 마크다운 설정을 build.js와 에디터가 같이 쓰는 markdown.js로`

### Task 2: 브라우저용 라이브러리 준비 (highlight.js 감싸기 + 배포 복사)

**Files:**
- Create: `tools/vendor.js` (실행하면 `vendor/highlight.js` 생성)
- Modify: `.gitignore` (`vendor/`)
- Modify: `serve.py` (`__main__`에서 서버 시작 전 `node tools/vendor.js` 한 번 실행, 실패하면 메시지 출력 후 종료)
- Modify: `.github/workflows/deploy.yml` ("Collect site files"에서 `node tools/vendor.js` 실행 후 `markdown.js`·`vendor/` 복사, `node_modules/`에서 `marked marked-highlight marked-footnote marked-gfm-heading-id github-slugger marked-katex-extension katex marked-emoji gemoji highlight.js`를 `_site/node_modules/`로 복사. `write.html`·`editor/`는 아직 없으니 Task 10에서 넣는다. 중간에 push해도 배포가 깨지지 않게 하려는 것이다)
- Test: `tests/vendor.test.js`

**Interfaces:**
- Produces: `vendor/highlight.js` — 기본 내보내기가 hljs 인스턴스인 ESM. `node_modules/highlight.js/lib/core.js` 본문을 `const module = { exports: {} };`와 `export default module.exports;` 사이에 넣는다(그 파일은 `require`가 없고 끝이 `module.exports = highlight;`). 이어서 `lib/index.js`의 `hljs.registerLanguage('<이름>', require('./languages/<파일>'))` 줄을 모두 읽어, 같은 이름과 `../node_modules/highlight.js/es/languages/<파일>.js` import로 등록한다. 그래서 Node와 같은 언어 목록이 된다.
- Produces: `generateHighlightModule(nodeModulesDir: string): string` (`tools/vendor.js`의 named export, 파일 쓰기 없이 내용만) — 테스트용.
- write.html의 import map은 Task 8이 쓴다. 키→경로: `marked`→`node_modules/marked/lib/marked.esm.js`, `marked-highlight`→`node_modules/marked-highlight/src/index.js`, `marked-footnote`→`node_modules/marked-footnote/dist/index.js`, `marked-gfm-heading-id`→`node_modules/marked-gfm-heading-id/src/index.js`, `github-slugger`→`node_modules/github-slugger/index.js`, `marked-katex-extension`→`node_modules/marked-katex-extension/lib/index.esm.js`, `katex`→`node_modules/katex/dist/katex.mjs`, `marked-emoji`→`node_modules/marked-emoji/src/index.js`, `gemoji`→`node_modules/gemoji/index.js`, `highlight.js`→`vendor/highlight.js`.

- [ ] **Step 1: 실패하는 테스트 작성** `tests/vendor.test.js`

```js
test('lib/index.js와 같은 언어를 모두 등록한다', () => {
  const src = generateHighlightModule('node_modules');
  const want = (readFileSync('node_modules/highlight.js/lib/index.js', 'utf8').match(/registerLanguage\(/g) || []).length;
  const got = (src.match(/registerLanguage\(/g) || []).length;
  assert.ok(want > 100, '기준 언어 수를 제대로 읽었는지');
  assert.equal(got, want, '브라우저 미리보기도 사이트와 같은 언어를 칠해야 한다');
  assert.ok(!/\brequire\(/.test(src), '브라우저에서 돌아야 하므로 require가 남으면 안 된다');
  assert.match(src, /export default module\.exports/, '기본 내보내기가 hljs');
});
```

- [ ] **Step 2: 실패 확인** — `npm test` → `tools/vendor.js` 없음.
- [ ] **Step 3: `tools/vendor.js` 작성** — `generateHighlightModule`과, 직접 실행됐을 때(`import.meta.url === pathToFileURL(process.argv[1]).href`) `vendor/highlight.js`에 쓰는 부분.
- [ ] **Step 4: 통과 확인** — `npm test` → PASS. `node tools/vendor.js` 뒤 `vendor/highlight.js`가 있다.
- [ ] **Step 5: 브라우저에서 불러지는지 확인** — `python serve.py`를 켠 뒤 브라우저 콘솔에서 `(await import('/vendor/highlight.js')).default.highlight('const a=1', {language:'js'}).value`를 실행해 `hljs-keyword`가 든 HTML이 나오는지 본다.
- [ ] **Step 6: 커밋(사용자 확인 후)** — `chore: 에디터 미리보기용 highlight.js 브라우저 모듈과 배포 복사`

### Task 3: 글 모델 `editor/post.js`

**Files:**
- Create: `editor/config.js`, `editor/post.js`, `editor/media.js`(이 Task에서는 `countEmptyAlt`만. 나머지는 Task 4)
- Test: `tests/post.test.js`

**Interfaces:**
- Produces `editor/config.js` 상수: `BLOG_REPO = 'cihwang/cihwang.github.io'`, `SITE_URL = 'https://cihwang.github.io/'`, `AUTH_KEY = 'blog.editor.auth'`, `LOCAL_PREFIX = 'blog.editor.local:'`, `AUTOSAVE_MS = 10000`, `MAX_IMAGE_PX = 2000`, `DEPLOY_POLL_MS = 5000`, `DEPLOY_TIMEOUT_MS = 180000`.
- Produces `editor/post.js`:
  - `parsePost(text: string): { meta: Record<string,string>, body: string }` — CRLF를 LF로 바꾼 뒤 `splitFrontMatter`.
  - `serializePost(meta, body: string): string` — 키 순서 `title, category, date, slug, draft`, 그 뒤 나머지 키는 원래 순서로. 빈 값은 쓰지 않는다. 줄바꿈은 LF, 본문 끝은 줄바꿈 하나. 값이 따옴표로 시작·끝나면 큰따옴표로 감싼다. 제목 안의 줄바꿈은 공백으로 바꾼다.
  - `slugFromTitle(title: string): string` — 소문자, 공백 묶음 → `-`, 글자·숫자·`-` 말고는 지움(`\p{L}\p{N}`), `-` 겹침·양끝 정리, 비면 `'post'`.
  - `postPath(date: string, slug: string): string` → `posts/${date}-${slug}.md`.
  - `validateDraft(meta, categories: string[]): string[]` — 제목 없음, 카테고리가 목록에 없음.
  - `validatePublish(meta, body, { categories, livePosts: {path,cat,slug}[], ownPath: string|null }): { errors: string[], warnings: string[] }` — `validateDraft` 오류 + 날짜 형식(`YYYY-MM-DD`) + slug 비었음 + 같은 카테고리 slug 겹침(자기 `ownPath`는 빼고). 경고: 설명 빈 그림 개수(`countEmptyAlt`, Task 4), 공개된 글의 slug가 바뀜(링크 끊김).
  - `validateCategoryName(name: string, existing: string[]): string[]` — Global Constraints의 이름 규칙. `name`은 앞뒤 공백을 뗀 뒤 검사한다.
  - `recategorize(text: string, from: string, to: string): string | null` — 머리말 `category`가 `from`이면 `to`로 바꾼 전체 글을 돌려주고, 아니면 null. 다른 줄과 본문은 한 글자도 바꾸지 않는다(그 한 줄만 바꾼다. `serializePost`로 다시 쓰지 않는다).

- [ ] **Step 1: 실패하는 테스트 작성** `tests/post.test.js` — 아래 단언을 모두 포함한다.

```js
const text = '---\r\ntitle: Agentforce Coworker 소개\r\ncategory: 공부\r\ndate: 2026-10-13\r\ndraft: true\r\nextra: 1\r\n---\r\n## 가 😀\r\n';
const { meta, body } = parsePost(text);
assert.equal(body, '## 가 😀\n', 'CRLF는 LF로');
assert.equal(serializePost(meta, body),
  '---\ntitle: Agentforce Coworker 소개\ncategory: 공부\ndate: 2026-10-13\ndraft: true\nextra: 1\n---\n## 가 😀\n',
  '알려진 키 순서 + 모르는 키 보존 + LF');
assert.deepEqual(parsePost(serializePost(meta, body)), { meta, body }, '왕복해도 같다');
assert.equal(slugFromTitle('Agentforce Coworker 소개'), 'agentforce-coworker-소개', '한글 유지');
assert.equal(slugFromTitle(' ?#/ '), 'post', '쓸 글자가 없으면 post');
assert.equal(postPath('2026-10-16', 'a-b'), 'posts/2026-10-16-a-b.md', '파일 규칙');
assert.deepEqual(validateDraft({ title: '', category: '없음' }, ['글', '공부']).length, 2, '제목·카테고리 둘 다 오류');
const live = [{ path: 'posts/x.md', cat: '공부', slug: 'a' }];
assert.ok(validatePublish({ title: 't', category: '공부', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부'], livePosts: live, ownPath: null }).errors.length === 1, '같은 카테고리 slug 겹침');
assert.equal(validatePublish({ title: 't', category: '공부', date: '2026-10-16', slug: 'a' }, '', { categories: ['공부'], livePosts: live, ownPath: 'posts/x.md' }).errors.length, 0, '자기 자신과는 겹침이 아니다');
assert.equal(validatePublish({ title: 't', category: '공부', date: '2026/10/16', slug: 'b' }, '![](../media/a.png)', { categories: ['공부'], livePosts: [], ownPath: null }).warnings.length, 1, '빈 설명 그림 경고');
assert.deepEqual(validateCategoryName('  일기 ', ['글']), [], '앞뒤 공백은 떼고 통과');
for (const bad of ['', 'a/b', '#x', '_비밀', '가'.repeat(21), '글']) assert.ok(validateCategoryName(bad, ['글']).length > 0, `거부해야 함: "${bad}"`);
const crlf = '---\r\ntitle: t\r\ncategory: 공부\r\n---\r\n본문 category: 공부\r\n';
assert.equal(recategorize(crlf, '공부', '배움'), '---\r\ntitle: t\r\ncategory: 배움\r\n---\r\n본문 category: 공부\r\n', '머리말 한 줄만, 줄바꿈·본문 그대로');
assert.equal(recategorize(crlf, '글', '배움'), null, '다른 카테고리 글은 건드리지 않는다');
```

- [ ] **Step 2: 실패 확인** — `npm test`.
- [ ] **Step 3: 구현** — `editor/config.js`, `editor/post.js`(`splitFrontMatter`는 `../markdown.js`에서 가져온다), `editor/media.js`의 `countEmptyAlt(body): number`(`![](` 개수, Task 4 Interfaces와 같은 정의).
- [ ] **Step 4: 통과 확인** — `npm test` → PASS.
- [ ] **Step 5: 커밋(사용자 확인 후)** — `feat: 에디터 글 모델(머리말 읽기·쓰기, slug, 검사)`

### Task 4: 서식 단추와 사진 도우미 `editor/format.js`, `editor/media.js`

**Files:**
- Create: `editor/format.js`
- Modify: `editor/media.js` (Task 3의 `countEmptyAlt`에 나머지를 더한다)
- Test: `tests/format.test.js`, `tests/media.test.js`

**Interfaces:**
- `applyFormat(text, start, end, kind): { text, start, end }` — `kind`: `'h2'|'h3'|'h4'|'bold'|'italic'|'strike'|'quote'|'link'|'code'`. 머리 기호(`h2`~`h4`, `quote`)는 선택이 걸친 줄마다 앞에 붙이고, 이미 같은 기호면 뗀다(토글). 감싸기(`bold` `**`, `italic` `*`, `strike` `~~`)는 선택을 감싸고, 선택이 없으면 기호 사이에 커서를 둔다. `link`는 `[선택](https://)`이고 `https://`를 선택해 둔다. `code`는 한 줄 선택이면 `` ` `` 감싸기, 여러 줄이거나 빈 선택이면 ```` ``` ```` 블록.
- `fitWithin(w, h, max): { w, h }` — 긴 변이 `max` 이하가 되게 비율 유지, 정수.
- `mediaFileName(originalName: string, now: Date, rand: string): string` → `media/YYYYMMDD-HHmmss-<rand>.<ext>` (서울 시간 아님, 기기 시간. 확장자 소문자, `jpeg`→`jpg`, 확장자가 없으면 `bin`).
- `mediaRefs(body): string[]` — `](../media/…)`의 `media/…` 경로(제목·`#loop` 제외), 중복 제거.
- `countEmptyAlt(body): number` — `![](` 개수.
- `resizeImage(file: Blob, max: number): Promise<Blob>` — 브라우저 전용(`createImageBitmap` + canvas). png/jpeg/webp만 줄이고 gif·svg·영상, 이미 작은 사진은 원본 그대로 돌려준다. 단위 테스트 없음, Task 8에서 브라우저 확인.

- [ ] **Step 1: 실패하는 테스트 작성** — 아래 단언을 모두 포함한다.

```js
assert.deepEqual(applyFormat('가나', 0, 2, 'bold'), { text: '**가나**', start: 2, end: 4 }, '선택 감싸기, 선택 유지');
assert.deepEqual(applyFormat('가', 1, 1, 'italic'), { text: '가**', start: 2, end: 2 }, '빈 선택이면 기호 사이 커서');
assert.equal(applyFormat('a\nb', 0, 3, 'quote').text, '> a\n> b', '걸친 줄마다');
assert.equal(applyFormat('## a', 0, 0, 'h2').text, 'a', '같은 기호면 토글로 뗀다');
assert.equal(applyFormat('### a', 0, 0, 'h2').text, '## a', '다른 제목 기호는 바꾼다');
assert.deepEqual(applyFormat('글', 0, 1, 'link'), { text: '[글](https://)', start: 4, end: 12 }, 'URL 자리를 선택');
assert.equal(applyFormat('a\nb', 0, 3, 'code').text, '```\na\nb\n```', '여러 줄은 블록');
assert.deepEqual(fitWithin(4032, 3024, 2000), { w: 2000, h: 1500 }, '긴 변 2000');
assert.deepEqual(fitWithin(800, 600, 2000), { w: 800, h: 600 }, '작으면 그대로');
assert.equal(mediaFileName('IMG.JPEG', new Date(2026, 9, 16, 14, 53, 1), 'ab12'), 'media/20261016-145301-ab12.jpg', '이름 규칙');
assert.deepEqual(mediaRefs('![](../media/a.png) ![x](../media/v.mp4#loop "t") ![](../media/a.png)'), ['media/a.png', 'media/v.mp4'], '경로만, 중복 없이');
assert.equal(countEmptyAlt('![](a) ![b](c) ![](d)'), 2, '설명 빈 그림 수');
```

- [ ] **Step 2: 실패 확인** — `npm test`.
- [ ] **Step 3: 구현** — 시그니처 그대로.
- [ ] **Step 4: 통과 확인** — `npm test` → PASS.
- [ ] **Step 5: 커밋(사용자 확인 후)** — `feat: 에디터 서식 단추 변환과 사진 이름·경로 도우미`

### Task 5: GitHub 클라이언트 `editor/github.js`

**Files:**
- Create: `editor/github.js`
- Test: `tests/github.test.js` (가짜 `fetch` 주입)

**Interfaces:**
- `createGitHub({ token, fetch = globalThis.fetch })` → 객체:
  - `getRepo(repo) → { private: boolean, push: boolean, defaultBranch: string }` (`permissions.push`, `default_branch`)
  - `getFile(repo, path) → { text, sha } | null` — 404면 null. 1MB 넘는 파일도 읽히게 `Accept: application/vnd.github.raw+json`으로 다시 받는다.
  - `getRaw(repo, path) → Blob | null` — 비공개 저장소 사진 미리보기용.
  - `putFile(repo, path, { text | base64, sha, message }) → { sha }` — 새 파일은 `sha` 없이.
  - `deleteFile(repo, path, sha, message) → void` — 404는 이미 지워진 것으로 보고 성공.
  - `listTree(repo) → { path, sha, type }[]` — `GET /repos/{r}/git/trees/{기본 브랜치}?recursive=1`. 빈 저장소(409)는 `[]`.
  - `lastCommitDate(repo, path) → string | null` — `GET /repos/{r}/commits?path=…&per_page=1`의 `commit.committer.date`.
  - `getBlobBase64(repo, sha) → string`
  - `commitFiles(repo, { message, files: { path, base64 }[], deletes: string[], expect: Record<string, string|null> }) → { commitSha }` — 한 커밋으로 올린다: ref → 기준 tree → blob들 → tree(`base_tree`, 삭제는 `sha: null`) → commit → ref PATCH. `expect`의 각 경로가 지금 tree의 sha와 다르면(null은 "없어야 함") `ConflictError`. ref PATCH가 422(앞서 누가 커밋)면 처음부터 최대 3번 다시 한다.
- 오류 클래스: `GitHubError(status, message)`, `AuthError extends GitHubError`(401·403), `ConflictError extends GitHubError`(`path` 속성, `putFile`의 409, 기존 파일에 sha 없이 PUT해서 생긴 422, `expect` 불일치).
- 헬퍼(named export): `encodePath(path)` — 경로 조각마다 `encodeURIComponent`. `utf8ToBase64(text)`, `base64ToUtf8(b64)` — 줄바꿈 들어간 base64도 읽는다.
- 모든 요청 헤더: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 fetch가 받은 요청을 기록하고 정해 둔 응답을 돌려준다. 아래를 모두 단언한다.
  - `utf8ToBase64('한글 😀\n')`을 `base64ToUtf8`로 되돌리면 그대로다. GitHub처럼 60자마다 `\n`을 넣은 base64도 읽는다.
  - `getFile('o/r', 'posts/예시/공부-01.md')` 요청 URL이 `/repos/o/r/contents/posts/%EC%98%88%EC%8B%9C/%EA%B3%B5%EB%B6%80-01.md`로 끝나고, 헤더 세 개가 붙는다.
  - 404 → `getFile`은 null, `deleteFile`은 오류 없이 끝난다.
  - 401 → `AuthError`, 409 → `ConflictError`(`path`가 요청 경로).
  - `listTree`가 빈 저장소 409에 `[]`를 돌려준다.
  - `commitFiles`: `expect: { 'posts/a.md': 'old' }`인데 tree의 sha가 `'new'`면 blob을 만들기 전에 `ConflictError`. ref PATCH 422가 한 번 나면 다시 시도해서 성공하고, 그때 tree는 새 ref 기준으로 다시 만든다. 삭제 경로는 tree 항목 `{ path, mode: '100644', type: 'blob', sha: null }`로 들어간다.
- [ ] **Step 2: 실패 확인** — `npm test`.
- [ ] **Step 3: 구현** — 시그니처 그대로.
- [ ] **Step 4: 통과 확인** — `npm test` → PASS.
- [ ] **Step 5: 커밋(사용자 확인 후)** — `feat: 에디터 GitHub 클라이언트(내용·트리·한 커밋 올리기·충돌·인증 오류)`

### Task 6: 저장·출간 흐름 `editor/store.js`, 기기 안 저장 `editor/local.js`, 배포 기다리기 `editor/deploy.js`

**Files:**
- Create: `editor/store.js`, `editor/local.js`, `editor/deploy.js`
- Test: `tests/store.test.js`, `tests/local.test.js`, `tests/deploy.test.js` (Task 5 클라이언트 모양의 가짜 객체, 메모리 저장소)

**Interfaces:**
- `Doc` 모양: `{ meta, body, draftPath: string|null, draftSha: string|null, blogPath: string|null, blogSha: string|null }`. `blogPath`가 있으면 "공개된 글 고치는 중"이다.
- `createStore({ gh, draftsRepo, blogRepo = BLOG_REPO, today = () => 'YYYY-MM-DD' })` → 객체:
  - `listDrafts(livePosts: {path,cat,slug,title}[]) → DraftEntry[]` — `DraftEntry = { repo: 'drafts'|'blog', path, title, category, updated, kind: 'new'|'editing'|'public-draft' }`. 초안 저장소 `posts/**.md`(`_`로 시작하는 이름 제외) → `livePosts`에 같은 경로가 있으면 `editing`, 없으면 `new`. 블로그 저장소 tree의 `posts/**.md` 중 `livePosts`에 없고 이름이 `_`로 시작하지 않으며 머리말 `draft: true`인 것 → `public-draft`. 최근 수정순.
  - `open({ repo, path }) → Doc` — 블로그 경로를 열 때 초안 저장소에 같은 경로가 있으면 그 내용을 열고 `blogSha`만 블로그 쪽에서 채운다.
  - `newDoc(category: string) → Doc` — `meta = { title:'', category, date: today(), draft:'true' }`.
  - `saveDraft(doc) → Doc` — `validateDraft`가 오류를 내면 `Error`(메시지에 오류 목록). 경로는 `doc.draftPath ?? doc.blogPath ?? postPath(meta.date, meta.slug || slugFromTitle(meta.title))`. `draft: 'true'`를 붙여 초안 저장소에 `putFile`(`sha: doc.draftSha`). 새 `draftSha`를 돌려준다. `ConflictError`는 그대로 올린다.
  - `uploadMedia(blob, originalName, rand) → 'media/…'` — 초안 저장소에 올린다.
  - `publish(doc, livePosts) → { path, alreadyPublished: boolean }`:
    1. 대상 경로 = `doc.blogPath`. 단, 새 글이거나 slug·날짜가 바뀌었으면 `postPath(date, slug)`로 바꾸고 옛 `blogPath`를 지울 목록에 넣는다.
    2. 올릴 내용 = `serializePost(meta에서 draft를 뺀 것, body)`. 블로그에 이미 같은 경로가 있고 내용이 똑같으면 커밋을 건너뛴다(`alreadyPublished: true`). 이렇게 해야 다시 눌러도 겹치지 않는다.
    3. 사진 = `mediaRefs(body)` 중 블로그 tree에 없고 초안 tree에 있는 것을 `getBlobBase64`로 가져와 함께 넣는다.
    4. `commitFiles(blogRepo, { message: '글: <제목>' (수정이면 '수정: <제목>'), files, deletes, expect })`. `expect`는 수정이면 `{ [doc.blogPath]: doc.blogSha }`, 새 글이면 `{ [대상]: null }`.
    5. 그 뒤에만 초안 저장소의 `doc.draftPath`를 지운다(없으면 건너뜀).
  - `deleteDraft(path, sha)`, `deletePost(path)` — 블로그 글 삭제는 `commitFiles`로(`message: '삭제: <제목>'`). 사진은 지우지 않는다.
  - `moveToDrafts(path) → Doc` — 블로그의 `public-draft`를 초안 저장소 같은 경로로 옮기고 블로그에서 지운다(블로그 쪽은 한 커밋).
  - `getSite() → { site: string, categories: string[], sha: string }` — 블로그 저장소 `site.json`.
  - `countByCategory(livePosts) → Record<string, number>` — 화면의 글 수 표시용(라이브 기준).
  - `addCategory(name) → string[]` — `validateCategoryName` 오류면 `Error`. `site.json`을 `JSON.stringify({ ...site, categories: [...categories, name.trim()] }, null, 2) + '\n'`로 `commitFiles`(`message: '카테고리 추가: <이름>'`, `expect: { 'site.json': sha }`).
  - `renameCategory(from, to) → { posts: number, drafts: number }` — 블로그 tree의 `posts/**.md`(`_` 제외)를 읽어 `recategorize`가 null이 아닌 것과 `site.json`(그 자리 이름만 바꿈)을 **한 커밋**으로 올린다(`message: '카테고리 이름 바꾸기: <from> → <to>'`, `expect`에 각 파일의 읽은 sha). 그다음 초안 저장소에서도 같은 방식으로 한 커밋. 블로그 커밋이 실패하면 초안 저장소는 건드리지 않는다. 초안 쪽만 실패하면 오류에 "블로그는 바뀜, 초안 N편은 그대로"를 담아 던진다(부분 실패를 부분 실패로).
- `createLocal(storage = localStorage)` → `save(key, data)`, `load(key) → data|null`, `clear(key)`, `keys() → string[]`. 키 앞에 `LOCAL_PREFIX`. `data = { meta, body, draftPath, draftSha, blogPath, blogSha, savedAt, remoteSavedAt }`. 손상된 JSON은 null(지우지 않는다).
- `waitForDeploy({ path, html, fetch, siteUrl = SITE_URL, sleep, pollMs = DEPLOY_POLL_MS, timeoutMs = DEPLOY_TIMEOUT_MS, now = Date.now }) → Promise<boolean>` — `siteUrl + 'posts.json?t=' + now()`를 받아 `posts[].path === path && html === html`이면 true. 시간이 넘으면 false. 받기 실패는 다음 차례에 다시 받는다.

- [ ] **Step 1: 실패하는 테스트 작성** — 메모리 가짜 gh(두 저장소의 파일 맵 + 호출 기록)로 아래를 모두 단언한다.
  - `listDrafts`: 초안 저장소 `posts/2026-10-16-a.md`(라이브에 없음) → `new`, `posts/예시/공부-01.md`(라이브에 있음) → `editing`. 블로그 `posts/2026-10-13-agentforce-coworker.md`(`draft: true`, 라이브에 없음) → `public-draft`. `_템플릿.md`는 빠진다.
  - `saveDraft`: 제목이 없으면 오류이고 gh 호출이 0번. 두 번째 저장은 첫 저장이 돌려준 sha를 쓴다. 가짜 gh가 그 사이 sha를 바꿔 두면 `ConflictError`가 나고 덮어쓰지 않는다.
  - `publish`(새 글): 블로그에 커밋 1번. 파일은 글 1개와 초안 저장소에만 있던 사진 1개이고, 글 내용에 `draft` 줄이 없다. `expect`는 대상이 null. 그다음 초안이 지워진다.
  - `publish`(공개된 글의 slug 변경): `deletes`에 옛 경로가 있고, `expect`가 옛 sha다.
  - **다시 출간:** 커밋은 됐고 초안 삭제가 던졌을 때 다시 `publish`하면, 커밋은 0번 더 생기고 초안 삭제만 다시 시도한다. 결과는 `alreadyPublished: true`.
  - **인증 오류:** gh가 `AuthError`를 던지면 `saveDraft`가 그대로 던지고, `createLocal`에 저장해 둔 내용은 그대로 남아 있다(앱이 그것으로 되살린다).
  - `createLocal`: 저장·읽기·지우기, 깨진 JSON은 null, 다른 접두어 키는 `keys()`에 안 나온다.
  - `waitForDeploy`: 첫 응답에는 글이 없고 두 번째에 html이 같으면 true. 받기가 계속 실패하면 시간 초과로 false(가짜 `sleep`·`now`).
  - `addCategory('일기')`: `site.json` 한 커밋, 카테고리 배열 끝에 `'일기'`. 이름이 겹치면 gh 호출 0번.
  - `renameCategory('공부', '배움')`: 블로그에 커밋 1번(공부 글 2편 + `site.json`, `글` 카테고리 글은 포함 안 됨). `site.json`의 순서는 그대로이고 그 자리만 `'배움'`이다. 초안 저장소에 커밋 1번(공부 초안 1편). 결과 `{ posts: 2, drafts: 1 }`. 블로그 커밋이 `ConflictError`면 초안 저장소 호출 0번.
- [ ] **Step 2: 실패 확인** — `npm test`.
- [ ] **Step 3: 구현** — 시그니처 그대로.
- [ ] **Step 4: 통과 확인** — `npm test` → 전부 PASS.
- [ ] **Step 5: 커밋(사용자 확인 후)** — `feat: 에디터 임시저장·출간·삭제 흐름과 기기 안 저장, 배포 기다리기`

### Task 7: 사용자 준비 (멈추고 사용자에게 요청)

화면 Task(8~10)의 확인에는 실제 저장소와 토큰이 필요하다. 사용자 계정으로만 할 수 있는 일이라 Claude가 대신하지 않는다.

- [ ] **Step 1: 사용자에게 아래를 요청하고 끝날 때까지 기다린다.**
  1. `cihwang` 계정으로 **비공개** 저장소를 만든다(이름 예: `blog-drafts`, README 없이 비워 둬도 됨).
  2. Fine-grained token을 만든다. Resource owner `cihwang`, Repository access는 `cihwang.github.io`와 그 초안 저장소만, Permissions → Repository → Contents **Read and write**(Metadata 읽기는 자동). 만료일은 사용자가 정한다.
  3. 토큰은 채팅에 붙여넣지 않는다. 에디터 로그인 화면에 직접 넣는다.
- [ ] **Step 2: 받은 정보 기록** — 초안 저장소 이름만 받는다(토큰은 받지 않는다).

### Task 8: 에디터 화면 — 뼈대, 로그인, 임시글 목록, 쓰기·미리보기

**Files:**
- Create: `write.html`, `editor/app.js`, `editor/editor.css`
- 쓰는 것: `styles.css`(토큰·`.post-title`·`.post-body` 규칙), `node_modules/katex/dist/katex.min.css`, Task 2 import map, Task 3~6 모듈

**Interfaces:**
- Consumes: Task 3~6의 모든 export, `markdown.js`의 `renderMarkdown`·`slugFromPath`.
- 주소(해시): `#/`(임시글 목록, 맨 위에 `새 글 쓰기`), `#/new`, `#/edit?repo=drafts|blog&path=<encodeURIComponent>`. 인증(`AUTH_KEY` = `{ token, draftsRepo }`)이 없으면 어느 주소든 로그인 화면.
- 라이브 정보: `fetch(SITE_URL + 'posts.json?t=…')`의 `posts[].{path,cat,slug,title,html}`. 카테고리 목록은 `store.getSite().categories`(블로그 `site.json`)를 쓴다(스펙 5-9).

화면 요구(스펙 5-1·5-3·5-7):
- **로그인:** 토큰 칸(`type="password"`, 라벨 있음), 초안 저장소 칸(`owner/name`), 토큰 만드는 법 단계 안내(Task 7 Step 1의 2번 내용). 확인을 누르면 `getRepo` 두 번을 부른다. 블로그 `push` 권한, 초안 저장소 `private === true`와 `push`가 모두 맞아야 저장한다. 아니면 무엇이 틀렸는지 해요체로 알린다. 로그아웃은 `AUTH_KEY`를 지운다.
- **임시글 목록:** `listDrafts` 결과. 제목·카테고리·`updated`(상대 시각)·종류 표시(`고치는 중`, `공개 저장소에 있음`). `이어 쓰기`, `삭제`(확인을 묻는다). `public-draft`를 열면 `moveToDrafts`할지 먼저 묻는다.
- **쓰기 화면:** 제목 textarea("제목을 입력하세요"), 카테고리 알약(라디오 버튼 그룹), 서식 단추 `H2 H3 H4 | B I S | 인용 링크 사진 코드`(각각 `aria-label`), 본문 textarea(D2Coding, 안내 문구 "이야기를 적어 보세요…"), 미리보기(`.post-title` + `.post-body`, 입력 후 150ms 묶어 `renderMarkdown`). 미리보기 안 `media/…` 그림은 초안 저장소에서 `getRaw`로 받은 blob URL로 바꿔 보여 준다(블로그에 이미 있는 사진은 사이트 주소 그대로). 아래 막대: `← 나가기`, 저장 상태 글("저장됨 · 14:32" / "이 기기에만 저장됨" / "저장 실패: …"), `임시저장`, `출간하기`(blogPath가 있으면 `수정하기`).
- **넓이 768px 이상:** 쓰기·미리보기 두 칸. **768px 미만:** 위에 `쓰기 | 미리보기` 탭(`role="tablist"`), 서식 단추 줄과 아래 막대는 화면 키보드 바로 위에 붙는다(`visualViewport`의 `resize`·`scroll`로 아래 여백 CSS 변수를 맞춘다).
- **단축키:** `Ctrl/Cmd+S` → 임시저장(`preventDefault`), `Ctrl/Cmd+B` → bold, `Ctrl/Cmd+I` → italic.
- **자동 저장:** 입력이 멈추고 `AUTOSAVE_MS` 뒤 `createLocal().save(문서 키, …)`. 문서 키는 `draftPath`, 없으면 `blogPath`, 없으면 새 글마다 만든 `new:<랜덤>`. 열 때 기기 저장본이 원격보다 새로우면 "이 기기에 더 최근 내용이 있어요" 하고 어느 쪽을 쓸지 묻는다.
- **나가기 경고:** 원격에 안 올린 변경이 있으면 `beforeunload`와 `← 나가기`에서 묻는다.
- **오류:** `AuthError` → 기기 저장 후 "로그인이 풀렸어요" + 로그인 화면으로(돌아오면 그 글로 복귀). `ConflictError` → Task 9 충돌 창. 그 밖의 실패 → 상태 글에 이유, 기기 저장본 유지.

- [ ] **Step 1: 화면 구현** — 위 요구대로.
- [ ] **Step 2: 브라우저 확인(PC 1280px·폰 390px 두 폭, `python serve.py` + Task 7 저장소)** — 아래를 하나씩 해 보고 결과를 기록한다.
  - 로그인: 틀린 토큰 → 오류 문구. 공개 저장소를 초안 저장소로 넣음 → 거부. 맞는 값 → 목록 화면.
  - 새 글: 제목·카테고리 없이 `Ctrl+S` → 무엇을 채울지 안내, GitHub 호출 없음. 채우고 `Ctrl+S` → 초안 저장소에 파일이 생긴다(GitHub 화면에서 확인).
  - 10초 기다린 뒤 새로고침 → 내용이 남아 있다.
  - 서식 단추 9개와 `Ctrl+B/I`가 Task 4 규칙대로 동작하고, 미리보기가 사이트 글 화면과 같은 모양이다(코드 색칠·수식·각주 포함, 예시 글 하나를 붙여넣어 사이트와 나란히 비교).
  - 폰 폭: 탭 전환이 되고, 본문 칸을 눌러 화면 키보드를 띄워도(실제 폰 또는 기기 흉내) 서식 줄·아래 막대가 가려지지 않는다.
  - 키보드만으로 모든 단추에 갈 수 있고 초점 표시가 보인다.
- [ ] **Step 3: 커밋(사용자 확인 후)** — `feat: 글쓰기 화면(로그인·임시글 목록·쓰기·미리보기·자동 저장)`

### Task 9: 에디터 화면 — 사진, 출간·수정, 충돌, 도움말

**Files:**
- Modify: `editor/app.js`, `editor/editor.css`

화면 요구(스펙 5-2·5-5·5-6):
- **사진:** 본문 칸에 붙여넣기(`clipboardData.files`)와 끌어다 놓기, `사진` 단추(`<input type="file" accept="image/*,video/mp4,video/webm">`, 폰에서는 사진첩·카메라). 고른 순간 커서 자리에 `![올리는 중…](uploading-<id>)`를 넣고, `resizeImage(file, MAX_IMAGE_PX)` → `uploadMedia` → 그 줄을 `![](../media/…)`로 바꾼다. 실패하면 그 줄을 지우고 이유를 알린다. 여러 장을 한꺼번에 넣으면 순서대로 올린다.
- **출간 설정 창**(`<dialog>`, 출간하기·수정하기를 누르면): 카테고리(알약), 날짜(`type="date"`, 기본 오늘), URL(slug 칸 + 미리 보이는 전체 주소 `SITE_URL + '#/' + 카테고리 + '/' + slug`). `validatePublish`의 오류는 칸 옆에, 경고(빈 설명 그림 N개, 링크 끊김)는 위에 보여 준다. 오류가 있으면 확인 단추가 비활성이다. 확인 → `publish` → "올리는 중"(배포 약 30초~1분) → `waitForDeploy`가 true면 `SITE_URL + '#/' + 카테고리 + '/' + slug`로 이동한다. false면 "아직 반영 중이에요. 잠시 후 사이트에서 확인해 주세요."와 링크를 보여 준다. 출간에 성공하면 그 글의 기기 저장본을 지운다.
- **충돌 창:** "다른 기기에서 먼저 저장했어요" + `다른 기기 내용 불러오기`(원격으로 바꾸기, 내 것은 기기 저장본으로 남김) · `내 것으로 덮어쓰기`(원격 최신 sha로 다시 저장) · `취소`.
- **삭제:** 쓰기 화면 메뉴에 `삭제`. 초안이면 `deleteDraft`, 공개 글이면 `deletePost`이고, 확인 문구에 "사이트에서 사라져요"를 넣는다.
- **도움말:** 아래 막대에 `?` 단추 → `getFile(BLOG_REPO, 'posts/_글쓰기-도움말.md')`를 `renderMarkdown`해서 `<dialog>`로 보여 준다.

- [ ] **Step 1: 구현** — 위 요구대로.
- [ ] **Step 2: 브라우저 확인(PC·폰 두 폭, 연습용 글 `[연습] 에디터 확인`)** — 하나씩 해 보고 기록한다.
  - PC: 캡처 붙여넣기, 파일 끌어다 놓기. 폰 폭: `사진` 단추로 고르기. 4000px 사진이 2000px로 올라간다(초안 저장소에서 확인). 미리보기에 보인다.
  - 설명 없이 출간 → 경고는 뜨지만 출간은 된다. 같은 카테고리에 이미 있는 slug → 확인 단추가 비활성.
  - 출간 → 1분 안에 사이트의 그 글로 이동한다. 사진이 블로그 `media/`에 복사됐고 초안은 지워졌다. 블로그에는 커밋 1개만 생겼다.
  - 사이트 글을 `수정`으로 열어 고치고 임시저장 → 사이트 공개본은 그대로다(새로고침으로 확인). `수정하기` → 바뀐 내용이 반영된다.
  - 두 탭에서 같은 초안을 열고 양쪽에서 고쳐 저장 → 두 번째 탭에 충돌 창이 뜬다. 세 단추가 각각 설명대로 동작한다.
  - 토큰을 GitHub에서 취소한 뒤 저장 → "로그인이 풀렸어요", 내용은 남는다. (확인 뒤 새 토큰은 사용자가 발급)
  - 연습 글 삭제 → 사이트에서 사라진다. 블로그 `media/`의 연습 사진은 남는다. 확인이 끝나면 사용자 확인을 받고 그 사진도 지운다.
- [ ] **Step 3: 커밋(사용자 확인 후)** — `feat: 글쓰기 화면 사진 올리기·출간·수정·충돌·도움말`

### Task 10: 카테고리 관리 화면

**Files:**
- Modify: `editor/app.js`, `editor/editor.css`

**Interfaces:**
- Consumes: Task 3 `validateCategoryName`, Task 6 `getSite`·`countByCategory`·`addCategory`·`renameCategory`.
- 주소 `#/categories`. 임시글 목록 화면 위에 `카테고리 관리` 링크를 둔다.

화면 요구(스펙 5-9):
- 목록: 휠 순서대로 이름과 글 수. 각 줄에 `이름 바꾸기`.
- `새 카테고리` 칸 + `만들기` 단추. 입력하는 동안 `validateCategoryName` 오류를 칸 아래에 보여 주고, 오류가 있으면 단추가 비활성이다.
- 이름 바꾸기 확인 창: "글 N편(라이브 기준)과 초안이 '<새 이름>'으로 옮겨지고, 예전 주소 `#/<옛 이름>/…`는 끊겨요." 확인 → `renameCategory` → 결과 `{ posts, drafts }`를 보여 준다. 부분 실패 오류면 그 문구를 그대로 보여 준다.
- 만들기·이름 바꾸기 뒤에는 `getSite()`를 다시 읽어 목록과 쓰기 화면의 카테고리 알약을 바로 갱신한다(배포를 기다리지 않는다).
- 쓰기 화면 카테고리 알약 끝에 `+`(→ `#/categories`)를 둔다.

- [ ] **Step 1: 구현.**
- [ ] **Step 2: 브라우저 확인(PC·폰 폭)** — `연습` 카테고리 만들기 → 목록 끝에 생기고, 쓰기 화면 알약에도 바로 보인다. 배포 후 사이트 휠에 빈 구간으로 보인다. `글` 같은 겹치는 이름이나 `a/b`는 단추가 비활성이다. `연습`에 연습 글 하나를 출간한 뒤 `연습2`로 이름 바꾸기 → 블로그 커밋 1개(그 글 + `site.json`). 사이트에서 `#/연습2/…`로 열린다. 확인이 끝나면 연습 글과 카테고리를 사용자 확인 후 정리한다(카테고리 삭제 기능이 없으므로 `site.json` 되돌리기는 사용자 확인 후 커밋으로).
- [ ] **Step 3: 커밋(사용자 확인 후)** — `feat: 카테고리 만들기·이름 바꾸기`

### Task 11: 사이트에 들어가는 길 + 배포

**Files:**
- Modify: `wheel.js` (`fillPost`, 홈 `foot-links`)
- Modify: `styles.css` (수정·글쓰기 링크 모양)
- Modify: `.github/workflows/deploy.yml` ("Collect site files"에 `write.html` 복사와 `editor/` 폴더 복사 추가)

**Interfaces:**
- Consumes: `posts.json`의 `path`(Task 1). `localStorage['blog.editor.auth']`가 있는지만 본다(wheel.js는 모듈이 아니라서 키 문자열을 그대로 쓰고, `editor/config.js` `AUTH_KEY`와 같다는 주석을 단다). `localStorage` 접근은 try/catch로 감싼다.
- Produces: 인증이 있으면 글 화면 `post-meta` 줄 끝에 `수정` 링크(`write.html#/edit?repo=blog&path=<encodeURIComponent(path)>`), 홈 아래 `foot-links`에 `글쓰기`(`write.html#/new`). 인증이 없으면 둘 다 DOM에 만들지 않는다.

- [ ] **Step 1: 구현.**
- [ ] **Step 2: 브라우저 확인** — 로그인한 기기: 글 화면에 `수정`, 홈에 `글쓰기`가 보이고 누르면 그 화면이 열린다. 시크릿 창(인증 없음): 둘 다 없다. 휠·스크롤 동작은 그대로다(글을 읽는 중 흐린 휠이 입력을 받지 않는다).
- [ ] **Step 3: 배포 확인(사용자 확인 후 push)** — Actions "Deploy blog" 성공. 사이트에서 `write.html`, `vendor/highlight.js`, `node_modules/marked/lib/marked.esm.js`, `node_modules/katex/dist/katex.min.css`가 200. 실제 사이트에서 Task 9 Step 2의 출간·수정을 한 번 더 해 본다(연습 글, 끝나면 삭제).
- [ ] **Step 4: 커밋(사용자 확인 후)** — `feat: 사이트에서 글쓰기·수정으로 들어가는 길`
