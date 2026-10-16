import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDeploy } from '../editor/deploy.js';

/** sleep이 ms만큼 시계를 앞으로 돌리는 가짜 시간. */
function fakeClock(start = 1000) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200 });

test('waitForDeploy: 첫 응답엔 글이 없고 두 번째에 html이 같으면 true', async () => {
  const clock = fakeClock();
  const urls = [];
  const answers = [
    { posts: [{ path: 'posts/other.md', html: '<p>다른 글</p>' }] },
    { posts: [{ path: 'posts/2026-10-16-hello.md', html: '<p>안녕</p>' }] },
  ];
  const fetch = async (url) => { urls.push(url); return json(answers[urls.length - 1]); };
  const ok = await waitForDeploy({
    path: 'posts/2026-10-16-hello.md', html: '<p>안녕</p>', fetch, siteUrl: 'https://example.test/',
    sleep: clock.sleep, pollMs: 5000, timeoutMs: 180000, now: clock.now,
  });
  assert.equal(ok, true, '반영되면 true');
  assert.equal(urls.length, 2, '두 번 받았다');
  assert.equal(urls[0], 'https://example.test/posts.json?t=1000', '캐시를 피하는 시각 붙은 주소');
  assert.equal(urls[1], 'https://example.test/posts.json?t=6000', '다음 차례는 pollMs 뒤');
  assert.deepEqual(clock.sleeps, [5000], '사이에 한 번 기다렸다');
});

test('waitForDeploy: 경로는 같아도 html이 다르면(옛 배포) 기다린다', async () => {
  const clock = fakeClock();
  let n = 0;
  const fetch = async () => {
    n += 1;
    return json({ posts: [{ path: 'posts/a.md', html: n < 3 ? '<p>옛</p>' : '<p>새</p>' }] });
  };
  const ok = await waitForDeploy({ path: 'posts/a.md', html: '<p>새</p>', fetch, sleep: clock.sleep, now: clock.now });
  assert.equal(ok, true, '새 html이 보이면 true');
  assert.equal(n, 3, '옛 내용 두 번 뒤 세 번째에 반영');
});

test('waitForDeploy: 받기가 계속 실패하면 시간이 넘어 false', async () => {
  const clock = fakeClock();
  let n = 0;
  const fetch = async () => {
    n += 1;
    if (n % 2) throw new TypeError('Failed to fetch');
    return new Response('없음', { status: 404 });
  };
  const ok = await waitForDeploy({ path: 'posts/a.md', html: '<p>x</p>', fetch, sleep: clock.sleep, pollMs: 5000, timeoutMs: 20000, now: clock.now });
  assert.equal(ok, false, '시간 초과는 false');
  assert.equal(n, 5, '0·5·10·15·20초에 받아 보고 포기한다(실패해도 다음 차례에 다시)');
  assert.ok(clock.now() - 1000 <= 20000, '시간 한도를 넘겨 기다리지 않는다');
});
