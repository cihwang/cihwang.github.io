// 출간 뒤 GitHub Pages 배포가 사이트에 반영됐는지 posts.json을 다시 받아 확인한다.
import { SITE_URL, DEPLOY_POLL_MS, DEPLOY_TIMEOUT_MS } from './config.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 제목·카테고리만 고친 수정은 경로·html이 그대로라, 이 칸들까지 같아야 새 배포로 본다.
const MATCHED = ['path', 'html', 'cat', 'title', 'slug', 'date'];

/**
 * 사이트 `posts.json`에 그 글이 출간한 그대로(경로·html·카테고리·제목·slug·날짜) 올라올 때까지 `pollMs`마다 받아 본다.
 * 받기 실패(네트워크·404·깨진 JSON)는 다음 차례에 다시 받는다.
 * @param {{ path: string, html: string, cat: string, title: string, slug: string, date: string, fetch?: typeof fetch,
 *   siteUrl?: string, sleep?: (ms: number) => Promise<void>, pollMs?: number, timeoutMs?: number, now?: () => number }} options
 *   기대하는 `posts.json` 글 항목 값: `path`는 `posts/…md`, `html`은 출간한 본문을 `renderMarkdown`한 것,
 *   `cat`·`title`·`slug`·`date`는 build.js가 머리말에서 만드는 값(slug가 없으면 경로에서, 날짜가 없으면 '').
 *   하나라도 빠지면 맞는 글이 없어 시간 초과로 끝난다. `siteUrl`은 `/`로 끝난다. 시간은 밀리초.
 * @returns {Promise<boolean>} 반영되면 true, `timeoutMs`가 지나면 false(실패가 아니라 "아직 반영 중").
 */
export async function waitForDeploy({
  path, html, cat, title, slug, date, fetch = globalThis.fetch, siteUrl = SITE_URL, sleep = wait,
  pollMs = DEPLOY_POLL_MS, timeoutMs = DEPLOY_TIMEOUT_MS, now = Date.now,
}) {
  const expected = { path, html, cat, title, slug, date };
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      // 시각을 붙여 Pages·브라우저 캐시의 옛 posts.json을 피한다.
      const res = await fetch(`${siteUrl}posts.json?t=${now()}`, { cache: 'no-store' });
      if (res.ok) {
        const { posts = [] } = await res.json();
        if (posts.some((p) => MATCHED.every((k) => p[k] === expected[k]))) return true;
      }
    } catch {
      // 배포 중 잠깐의 받기 실패는 정상이다. 다음 차례에 다시 받는다.
    }
    if (now() + pollMs > deadline) return false;
    await sleep(pollMs);
  }
}
