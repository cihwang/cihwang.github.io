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
/** posts.json 글 항목에서 경로·html 말고 맞춰 보는 칸들. */
const META = { cat: '글', title: '안녕', slug: 'hello', date: '2026-10-16' };

test('waitForDeploy: 첫 응답엔 글이 없고 두 번째에 html이 같으면 true', async () => {
  const clock = fakeClock();
  const urls = [];
  const answers = [
    { posts: [{ path: 'posts/other.md', html: '<p>다른 글</p>' }] },
    { posts: [{ ...META, path: 'posts/2026-10-16-hello.md', html: '<p>안녕</p>' }] },
  ];
  const fetch = async (url) => { urls.push(url); return json(answers[urls.length - 1]); };
  const ok = await waitForDeploy({
    ...META, path: 'posts/2026-10-16-hello.md', html: '<p>안녕</p>', fetch, siteUrl: 'https://example.test/',
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
    return json({ posts: [{ ...META, path: 'posts/a.md', html: n < 3 ? '<p>옛</p>' : '<p>새</p>' }] });
  };
  const ok = await waitForDeploy({ ...META, path: 'posts/a.md', html: '<p>새</p>', fetch, sleep: clock.sleep, now: clock.now });
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
  const ok = await waitForDeploy({ ...META, path: 'posts/a.md', html: '<p>x</p>', fetch, sleep: clock.sleep, pollMs: 5000, timeoutMs: 20000, now: clock.now });
  assert.equal(ok, false, '시간 초과는 false');
  assert.equal(n, 5, '0·5·10·15·20초에 받아 보고 포기한다(실패해도 다음 차례에 다시)');
  assert.ok(clock.now() - 1000 <= 20000, '시간 한도를 넘겨 기다리지 않는다');
});

for (const [field, old] of [['title', '옛 제목'], ['cat', '공부'], ['slug', 'old-slug'], ['date', '2026-10-01']]) {
  test(`waitForDeploy: 경로·html이 같아도 ${field}가 옛것이면(제목·카테고리만 고친 수정) 기다린다`, async () => {
    const clock = fakeClock();
    let n = 0;
    const fetch = async () => {
      n += 1;
      return json({ posts: [{ ...META, [field]: n < 3 ? old : META[field], path: 'posts/a.md', html: '<p>같음</p>' }] });
    };
    const ok = await waitForDeploy({ ...META, path: 'posts/a.md', html: '<p>같음</p>', fetch, sleep: clock.sleep, now: clock.now });
    assert.equal(ok, true, '새 값이 보이면 true');
    assert.equal(n, 3, `옛 ${field}가 보이는 동안(두 번)은 반영된 것으로 보지 않는다`);
  });
}
