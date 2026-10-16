/**
 * 모든 화면 위쪽의 휠 하나. 생김새와 움직임은 rauno.me/craft의 Wheel Interface(2024.04)를 따랐다.
 *
 * 원 한 바퀴(100%)를 홈과 카테고리가 똑같이 나눠 갖는다(홈 + 카테고리 4개면 20%씩).
 * 글은 자기 카테고리 구간 안에 고르게 놓인다. 휠은 끝없이 돈다(취향 다음이 다시 홈).
 * 단계는 확대 정도로 나눈다.
 *   0단계(축소): 홈·카테고리 이름만 보인다. 글은 이름 없는 짧은 눈금. 아래 = 홈 랜딩 또는 카테고리 글 목록.
 *   1단계(확대): 카테고리 구간이 벌어지며 글 제목이 보인다. 아래 = 글 본문.
 *
 * 어느 화면에서나 같은 세 동작만 쓴다.
 *   돌리기 = 같은 단계의 옆 항목(가로 끌기, 휠 위 스크롤, ← →)
 *   누르기 = 안으로(라벨·목록 누르기, Enter, 트랙패드 핀치 아웃)
 *   나가기 = 밖으로(맨 위 가운데 이름, Esc, 핀치 인)
 *
 * 위치 단위는 '칸'(u). 한 바퀴 = PERIOD 칸, 한 구간 = SECTOR 칸. 가운데 오는 자리 = -pos(한 바퀴로 감아서).
 */
(async () => {
  'use strict';

  const ARC_TOP = 170;             // 원 꼭대기의 y(px). styles.css --wheel-h와 함께 움직인다
  // 단계마다 원 크기 자체가 다르다(영상처럼 꼭대기 한 점을 고정하고 원이 커졌다 작아진다).
  const VISIBLE_DEG = [100, 60];   // 화면 너비에 들어오는 호의 각도: [0단계, 1단계]
  const MIN_R = [420, 560];        // 좁은 화면에서 원이 너무 작아지지 않게
  const SECTOR = 12;               // 구간 하나(홈 또는 카테고리 하나)의 칸 수
  const FINE = 4;                  // 칸 하나를 나누는 가는 눈금 수(1단계에서 촘촘한 결)
  // 0단계: 구간 하나가 화면 너비의 SECTOR_SHARE만큼(좁은 화면에선 최소 SECTOR_MIN_PX). 이웃 카테고리가 양옆에 보인다.
  const SECTOR_SHARE = 0.2;
  const SECTOR_MIN_PX = 140;
  const POST_GAP_PX = 144;         // 1단계: 가장 촘촘한 카테고리의 글 사이 간격(px)
  const ZOOM_MS = 900;             // 단계를 바꾸는 확대·축소(영상과 같은 길이)
  const FLIGHT_MS = [420, 0.8, 900]; // 같은 단계 이동: [기본, 화면 거리 1px당 추가, 최대]
  const SNAP = 0.14;               // 60fps 기준 프레임당 목표까지 남은 거리를 좁히는 비율
  const FRICTION = 0.93;           // 60fps 기준 프레임당 감속
  const SWAP_MS = 220;             // 아래 내용이 흐려졌다 바뀌는 시간
  const WHEEL_IDLE_MS = 140;       // 트랙패드 입력이 끊긴 뒤 가까운 항목에 붙기까지
  // 섬세한 스크롤: 손을 떼기 직전 CAREFUL_WINDOW_MS 동안 평균 속도가 CAREFUL_PX_PER_MS보다 느리고,
  // 가운데가 다른 단계의 항목 눈금에서 PRECISE_PX 안에 멈췄으면, ARM_MS 동안 차오른 뒤 그 항목으로 간다.
  const CAREFUL_PX_PER_MS = 0.25;
  const CAREFUL_WINDOW_MS = 300;
  const PRECISE_PX = 8;
  const ARM_MS = 900;
  const DIM_RED = 0.4;             // 다른 단계 항목·사이 눈금이 가운데 올 때 '지금 여기' 색의 세기
  const PINCH_STEP = 40;           // 핀치 누적량이 이만큼 넘으면 한 단계 들어가거나 나온다
  const BLUR_MAX = 8;              // 아래로 읽어 내려갈 때 휠이 흐려지는 최대치(px)
  // 돌리는 손맛: 도는 속도만큼 가운데 근처 눈금이 부풀었다가, 멈추면 살짝 되튀며 가라앉는다. 멈춰 있을 땐 모양 그대로.
  const STRETCH_PX = 14;           // 가장 빠를 때 가운데 눈금이 바깥으로 늘어나는 길이
  const STRETCH_FULL_PX = 12;      // 60fps 기준 프레임당 이만큼(화면 거리) 움직이면 최대로 부푼다
  const LENS_PX = 110;             // 부풂이 퍼지는 반경(가운데에서 화면 거리)
  const SPRING_K = 0.12;           // 부풂이 속도를 따라가는 힘
  const SPRING_DAMP = 0.73;        // 60fps 기준 프레임당 감쇠. 1에 가까울수록 오래 출렁인다(지금 약 20% 되튐)

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 데이터 → 원 위 자리 ─────────────────────────────────
  // posts.json은 build.js가 posts/*.md로 만든다(로컬에선 serve.py가 저장할 때마다 다시 만든다).
  let data;
  try {
    const res = await fetch('posts.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('posts.json ' + res.status);
    data = await res.json();
  } catch (err) {
    console.error('[blog] 글 목록을 불러오지 못했어요', err);
    const recentList = document.querySelector('[data-role="recent"]');
    if (recentList) recentList.textContent = '글 목록을 불러오지 못했어요. python serve.py 로 열었는지, node build.js 가 성공했는지 확인해 주세요.';
    return;
  }
  // 같은 목록을 다시 받지 않게 다른 스크립트(help.js: 글쓰기 도움말)에 넘겨준다.
  document.dispatchEvent(new CustomEvent('postsloaded', { detail: data }));
  const fmtDate = (d) => (d ? d.replace(/-/g, '.') : '[날짜]');

  // slots = 원 위의 항목(홈, 카테고리, 글). 번호가 곧 항목의 이름표다. u = 원 위 자리(칸).
  // 구간 k(0 = 홈)는 [k*SECTOR, (k+1)*SECTOR). 카테고리 눈금은 구간 시작, 글 n편은 그 뒤를 n+1 등분한 자리.
  // 글 자리는 가는 눈금 격자에 맞춰 반올림한다(사이 눈금과 엇갈려 보이지 않게).
  const slots = [{ kind: 'home', u: 0, catIndex: -1 }];
  const postSlots = [];
  const catSlot = {};
  data.categories.forEach((cat, ci) => {
    const start = (ci + 1) * SECTOR;
    catSlot[cat] = slots.length;
    slots.push({ kind: 'cat', cat: cat, u: start, catIndex: ci });
    const list = data.posts.filter((p) => p.cat === cat);
    list.forEach((post, j) => {
      postSlots.push(slots.length);
      const u = Math.round((start + (j + 1) * SECTOR / (list.length + 1)) * FINE) / FINE;
      slots.push({ kind: 'post', cat: cat, post: post, u: u, catIndex: ci });
    });
  });
  const HOME = 0;
  const PERIOD = (data.categories.length + 1) * SECTOR; // 한 바퀴
  const targets = [slots.map((x, i) => (x.kind === 'home' || x.kind === 'cat' ? i : -1)).filter((i) => i >= 0), postSlots];
  const targetSet = targets.map((list) => new Set(list));
  const itemFine = new Set(slots.map((x) => Math.round(x.u * FINE))); // 항목 자리의 가는 눈금 번호(사이 눈금을 겹쳐 그리지 않게)
  const postsOf = (cat) => postSlots.filter((i) => slots[i].cat === cat);
  // 1단계 확대 정도: 가장 촘촘한 카테고리의 글 간격이 POST_GAP_PX가 되게.
  const minPostGapU = data.categories.reduce((m, cat) => {
    const n = postsOf(cat).length;
    return n ? Math.min(m, SECTOR / (n + 1)) : m;
  }, SECTOR / 2);
  // 최근 글: 날짜가 늦은 순. 날짜 없는 글(예시 초안 등)은 뒤로.
  const recent = postSlots.slice().sort((a, b) => {
    const da = slots[a].post.date;
    const db = slots[b].post.date;
    return da === db ? 0 : da < db ? 1 : -1;
  });

  // ── 주소 ↔ 항목 ────────────────────────────────────────
  // #/ = 홈, #/공부 = 카테고리, #/공부/휠을-만들며 = 그 카테고리의 글(slug). 글을 더 써도 기존 주소가 안 바뀐다.
  // 깊이(홈 0 · 카테고리 1 · 글 2)가 곧 브라우저 기록의 깊이다. 그래서 뒤로 가기 = 나가기.
  const depthOf = (slot) => ({ home: 0, cat: 1, post: 2 })[slots[slot].kind];

  function hashFor(slot) {
    const x = slots[slot];
    if (x.kind === 'home') return '#/';
    if (x.kind === 'cat') return '#/' + encodeURIComponent(x.cat);
    return '#/' + encodeURIComponent(x.cat) + '/' + encodeURIComponent(x.post.slug);
  }

  // 모르는 주소는 홈으로 본다.
  function slotFromHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch (err) { return ''; }
    });
    if (!parts.length || catSlot[parts[0]] == null) return HOME;
    if (parts.length === 1) return catSlot[parts[0]];
    const found = postsOf(parts[0]).find((i) => slots[i].post.slug === parts[1]);
    return found != null ? found : catSlot[parts[0]];
  }

  const stateFor = (slot, pushed) => ({ slot: slot, depth: depthOf(slot), pushed: pushed });

  // ── DOM ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const docEl = document.documentElement;
  const baseTitle = document.title;
  const wheel = $('[data-role="wheel"]');
  const tickLayer = $('[data-role="ticks"]');
  const labelLayer = $('[data-role="labels"]');
  const hub = $('[data-role="hub"]');
  const page = $('[data-role="page"]');
  const views = { home: $('[data-view="home"]'), cat: $('[data-view="cat"]'), post: $('[data-view="post"]') };
  const recentEl = $('[data-role="recent"]');
  const popularEl = $('[data-role="popular"]');
  const visitsTodayEl = $('[data-role="visits-today"]');
  const visitsTotalEl = $('[data-role="visits-total"]');
  const catTitle = $('[data-role="cat-title"]');
  const catRows = $('[data-role="cat-rows"]');
  const postMeta = $('[data-role="post-meta"]');
  const postTitle = $('[data-role="post-title"]');
  const postBody = $('[data-role="post-body"]');
  // 글 안의 제목 앵커·각주 링크(#h-…, #footnote-…)는 주소를 바꾸지 않고 그 자리로만 스크롤한다.
  // 주소(#)를 바꾸면 휠의 주소 규칙(#/카테고리/글)과 부딪혀 홈으로 가 버린다.
  postBody.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || a.getAttribute('href').startsWith('#/')) return;
    e.preventDefault();
    const target = postBody.querySelector('[id="' + CSS.escape(decodeURIComponent(a.getAttribute('href').slice(1))) + '"]');
    if (target) target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });
  const prevBtn = $('[data-role="prev"]');
  const nextBtn = $('[data-role="next"]');
  const clockEl = $('[data-role="clock"]');
  const announcer = $('[data-role="announce"]');

  // 눈금 요소는 화면에 보이는 만큼만 그때그때 꺼내 쓴다(원 한 바퀴가 몇 번 보이든 같은 방식).
  const tickPool = [];
  let tickUsed = 0;

  const labels = [];
  slots.forEach((slot, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'label' + (slot.kind === 'post' ? '' : ' is-group');
    const name = document.createElement('span');
    name.className = 'label-name';
    const sub = document.createElement('span');
    sub.className = 'label-sub';
    if (slot.kind === 'home') { name.textContent = '홈'; sub.textContent = data.site; }
    else if (slot.kind === 'cat') { name.textContent = slot.cat; sub.textContent = String(postsOf(slot.cat).length).padStart(2, '0') + '편'; }
    else { name.textContent = slot.post.title; sub.textContent = fmtDate(slot.post.date); btn.title = slot.post.title; }
    btn.append(name, sub);
    btn.addEventListener('click', () => press(i));
    labelLayer.appendChild(btn);
    labels.push({ slot: i, el: btn, w: 0, h: 0 });
  });

  // ── 상태 ─────────────────────────────────────────────
  const s = {
    level: 0,          // 목표 단계
    z: 0,              // 지금 확대 정도(0~1, 멀리 이동하는 동안은 0보다 작을 수 있다)
    flight: null,      // 진행 중인 이동(flyTo)
    pos: -slots[HOME].u,
    vel: 0,            // 칸/프레임(60fps 기준)
    prevPos: -slots[HOME].u, // 지난 프레임의 pos — 화면에서 도는 속도를 잰다
    stretch: 0,        // 부푼 정도(0~1, 되튈 때는 잠깐 0보다 작다)
    stretchVel: 0,
    rotTarget: null,
    cur: HOME,         // 아래에 보여 주는 항목
    aim: -1,           // 돌아가는 중인 항목
    drag: null,
    justDragged: false,
    wheelTimer: null,
    pinch: 0,
    pinchLock: false,
    hover: null,
    raf: null,
    lastT: 0,
    finesVisible: false,  // 가는 눈금이 보이는 단계인가
    centerSlot: -1,       // 가운데에 걸린 항목(없으면 -1)
    centerIsTarget: true, // 그 항목이 지금 단계에서 고를 수 있는 항목인가
    arm: null,            // 섬세하게 멈춘 다른 단계 항목 { slot, start }. 차오르면 그 항목으로 간다
    armP: 0,              // 차오른 정도(0~1)
    wheelLog: [],         // 트랙패드 입력 기록 { t, px } — 섬세함 판정용
    swapTimer: null,
    historyLock: null,    // 뒤로/앞으로 가기로 움직이는 중인 항목. 도착해도 기록을 다시 쓰지 않는다
    pendingOut: null      // 화면에서 '나가기'를 눌러 history.back()을 부른 뒤 도착할 항목
  };

  // ── 계산 도우미 ────────────────────────────────────────
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // 한 바퀴로 감아 [-PERIOD/2, PERIOD/2)로: 원 위에서 가장 가까운 쪽 거리.
  const wrap = (x) => x - PERIOD * Math.round(x / PERIOD);
  // 항목이 가운데에서 얼마나 떨어져 있나(칸, 시계 방향 +).
  const deltaOf = (slot) => wrap(slots[slot].u + s.pos);

  // z: 0 = 0단계, 1 = 1단계.
  // 반지름과 칸 간격을 모두 기하 보간한다: 선형으로 키우면 끝에서 갑자기 커져 보인다.
  function geom() {
    const vw = docEl.clientWidth;
    const z = s.z;
    const R0 = Math.max(vw / 2 / Math.sin(rad(VISIBLE_DEG[0] / 2)), MIN_R[0]);
    const R1 = Math.max(vw / 2 / Math.sin(rad(VISIBLE_DEG[1] / 2)), MIN_R[1]);
    const R = R0 * Math.pow(R1 / R0, z);
    const unitPx0 = Math.max(vw * SECTOR_SHARE, SECTOR_MIN_PX) / SECTOR;
    const unitPx1 = Math.max(POST_GAP_PX / minPostGapU, unitPx0 * 2);
    const unitPx = unitPx0 * Math.pow(unitPx1 / unitPx0, z);
    const f = s.flight;
    return {
      vw: vw, R: R, unitPx: unitPx,
      e: clamp(z, 0, 1),               // 눈금 색·길이용 단계 정도
      stepDeg: deg(unitPx / R),        // 칸 하나의 각도
      half: deg(Math.asin(Math.min(1, vw / 2 / R))),
      cx: vw / 2, cy: ARC_TOP + R,
      fineOpacity: clamp((unitPx / FINE - 6) / 10, 0, 1), // 가는 눈금은 간격이 넓어질 때만
      // 확대·축소 한가운데에서 눈금이 잠깐 길고 굵어진다(영상의 중간 프레임과 같은 느낌).
      pulse: f ? f.pulse : 0,
      stretch: s.stretch,
      // 크게 움직이는 동안은 라벨을 거의 감췄다가 도착하면 다시 띄운다.
      labelDim: f ? 1 - 0.85 * f.pulse : 1
    };
  }

  function nearestTarget(level) {
    let best = null, bd = Infinity;
    targets[level].forEach((i) => { const d = Math.abs(deltaOf(i)); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  // 가운데에 가장 가까운 항목(종류 무관)과 그 거리(칸).
  function nearestItem() {
    let best = HOME, bd = Infinity;
    slots.forEach((_, i) => { const d = Math.abs(deltaOf(i)); if (d < bd) { bd = d; best = i; } });
    return { slot: best, dist: bd };
  }

  // ── 그리기: 눈금 ───────────────────────────────────────
  // 항목 눈금의 모양. 글은 확대할수록 진하고 길어지고, 홈·카테고리는 반대로 옅어진다.
  function itemStyle(slot, g) {
    const kind = slots[slot].kind;
    if (kind === 'post') {
      return g.e > 0.5
        ? { cls: 'tick is-event', rgb: palette.event, len: lerp(12, 32, g.e), ext: lerp(0, 12, g.e), o: 1, slot: slot }
        : { cls: 'tick is-soft', rgb: palette.soft, len: lerp(12, 32, g.e), ext: lerp(0, 12, g.e), o: 1, slot: slot };
    }
    return g.e > 0.5
      ? { cls: 'tick is-soft', rgb: palette.soft, len: lerp(30, 28, g.e), ext: lerp(12, 4, g.e), o: 1, slot: slot }
      : { cls: 'tick is-event', rgb: palette.event, len: lerp(30, 28, g.e), ext: lerp(12, 4, g.e), o: 1, slot: slot };
  }

  // 가운데 빨강을 눈금 사이로 흐르게: 가운데까지의 거리(칸)로 0~1 무게를 매겨, 가까울수록 서서히 물들고 살짝 길어진다.
  // 두 눈금 사이에 있으면 둘이 나눠 물든다. 지금 단계의 항목은 진하게, 아니면 흐리게.
  // 가는 눈금이 숨은 단계에서는 칸 눈금·항목 눈금만 물든다(없는 자리에 색이 생기지 않게).
  function centerGlow(delta, st) {
    if (!st.candidate) return 0;
    const span = s.finesVisible ? 1 / FINE : 1;
    let w = clamp(1 - Math.abs(delta) / span, 0, 1);
    w = w * w * (3 - 2 * w);
    let strength = st.slot != null && targetSet[s.level].has(st.slot) ? 1 : DIM_RED;
    // 섬세하게 멈춘 다른 단계 항목: 흐린 빨강에서 진한 빨강으로 천천히 차오른다.
    if (s.arm && st.slot === s.arm.slot) strength = DIM_RED + (1 - DIM_RED) * easeInOut(s.armP);
    return w * strength;
  }

  // 부풂의 모양: 가운데에서 가까운 눈금일수록 많이 받는다(종 모양, LENS_PX 밖은 0). 멈춰 있으면 0.
  function bumpAt(delta, g) {
    if (g.stretch === 0) return 0;
    const x = delta * g.unitPx / LENS_PX;
    return x * x < 1 ? (1 - x * x) * (1 - x * x) * g.stretch : 0;
  }

  const mixRgb = (a, b, t) => 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';

  // 눈금 색은 styles.css 변수에서 읽는다. 화이트/블랙이 바뀌면(themechange) 다시 읽는다.
  function readPalette() {
    const css = getComputedStyle(docEl);
    const rgbOf = (name) => {
      const hex = css.getPropertyValue(name).trim().replace('#', '');
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    };
    return { tick: rgbOf('--tick'), soft: rgbOf('--tick-soft'), event: rgbOf('--tick-event'), accent: rgbOf('--accent') };
  }
  let palette = readPalette();
  document.addEventListener('themechange', () => { palette = readPalette(); render(); });

  function drawTick(delta, st, g) {
    let el = tickPool[tickUsed];
    if (!el) { el = document.createElement('span'); tickLayer.appendChild(el); tickPool.push(el); }
    tickUsed++;
    if (el._cls !== st.cls) { el.className = st.cls; el._cls = st.cls; }
    el.style.display = '';
    const glow = centerGlow(delta, st);
    const bump = bumpAt(delta, g);
    const ext = st.ext + lerp(8, 16, g.e) * glow + STRETCH_PX * bump;
    // 옅은 바탕 눈금도 부푸는 동안은 진해져야 움직임이 보인다.
    const o = Math.max(st.o + (1 - st.o) * Math.max(0, bump), glow);
    el.style.opacity = o > 0.99 ? '' : o.toFixed(2);
    el.style.backgroundColor = glow > 0.01 ? mixRgb(st.rgb, palette.accent, glow) : '';
    el.style.height = Math.max(1, (st.len + ext) * (1 + 0.5 * g.pulse)).toFixed(1) + 'px';
    const w = 1 + 0.6 * g.pulse + 0.4 * glow;
    el.style.width = w > 1.02 ? w.toFixed(2) + 'px' : '';
    el.style.transform = 'translate(' + g.cx.toFixed(1) + 'px,' + g.cy.toFixed(1) + 'px) rotate(' + (delta * g.stepDeg).toFixed(3) + 'deg) translateY(' + (-(g.R + ext)).toFixed(1) + 'px) translateX(-50%)';
  }

  function renderTicks(g) {
    tickUsed = 0;
    const span = (g.half + 3) / g.stepDeg; // 화면에 들어오는 칸 수(가운데에서 한쪽)
    // 바탕 눈금: 칸마다 하나(늘 보임), 그 사이 가는 눈금(간격이 넓을 때만). 항목 자리는 건너뛴다.
    const fLo = Math.ceil((-span - s.pos) * FINE);
    const fHi = Math.floor((span - s.pos) * FINE);
    const period = PERIOD * FINE;
    const base = { cls: 'tick', rgb: palette.tick, len: lerp(8, 22, g.e), ext: 0, slot: null };
    for (let f = fLo; f <= fHi; f++) {
      if (itemFine.has(((f % period) + period) % period)) continue;
      const onUnit = f % FINE === 0;
      const o = onUnit ? Math.max(0.6, g.fineOpacity) : g.fineOpacity;
      if (o < 0.02) continue;
      base.o = o;
      base.candidate = onUnit || s.finesVisible;
      drawTick(f / FINE + s.pos, base, g);
    }
    // 항목 눈금: 한 바퀴가 화면보다 짧으면(0단계) 양쪽 반복분도 그린다.
    slots.forEach((_, i) => {
      const d0 = deltaOf(i);
      const st = itemStyle(i, g);
      st.candidate = true;
      for (let c = -1; c <= 1; c++) {
        const d = d0 + c * PERIOD;
        if (Math.abs(d) <= span) drawTick(d, st, g);
      }
    });
    for (let i = tickUsed; i < tickPool.length; i++) tickPool[i].style.display = 'none';
  }

  // ── 그리기: 라벨(겹치면 우선순위 낮은 쪽을 숨긴다) ────────────────
  function renderLabels(g) {
    const candidates = [];
    labels.forEach((lb) => {
      const slot = slots[lb.slot];
      const a = deltaOf(lb.slot) * g.stepDeg;
      if (Math.abs(a) > g.half + 2) { hideLabel(lb, true); return; }
      const ar = rad(a);
      const isGroup = slot.kind !== 'post';
      const atCenter = lb.slot === s.centerSlot;
      const isRed = atCenter && s.centerIsTarget;
      // 라벨도 자기 눈금과 함께 부풂을 탄다(눈금이 라벨에 닿지 않게).
      const ext = (isRed ? lerp(22, 34, g.e) : isGroup ? lerp(12, 4, g.e) : lerp(0, 12, g.e)) + STRETCH_PX * bumpAt(deltaOf(lb.slot), g);
      const reach = g.R + ext + 8 + Math.abs(Math.sin(ar)) * lb.w / 2 + Math.abs(Math.cos(ar)) * lb.h / 2;
      const x = g.cx + reach * Math.sin(ar);
      const y = g.cy - reach * Math.cos(ar);
      const edge = clamp((g.half - Math.abs(a)) / 4, 0, 1);
      const hoverProx = s.hover && s.hover.y < ARC_TOP + 60 ? clamp(1 - Math.abs(x - s.hover.x) / 150, 0, 1) : 0;
      let base;
      if (isRed) base = 1;
      else if (atCenter) base = s.arm && s.arm.slot === lb.slot ? 0.6 + 0.4 * s.armP : 0.6; // 다른 단계의 항목이 가운데를 지나면 흐리게 이름만
      else if (isGroup) base = lerp(1, 0.55, g.e);
      else base = Math.max(g.e * Math.pow(clamp(1 - Math.abs(x - g.cx) / 380, 0, 1), 0.8), hoverProx);
      const o = base * edge * (isRed ? Math.max(g.labelDim, 0.5) : g.labelDim);
      if (o < 0.05) { hideLabel(lb, false, x, y); return; }
      const levelMatch = (isGroup ? 0 : 1) === s.level;
      const armed = !!(s.arm && s.arm.slot === lb.slot);
      candidates.push({ lb: lb, x: x, y: y, o: o, prio: (isRed || armed ? 1000 : 0) + (levelMatch ? 100 : 0) + o * 50 + hoverProx * 80 });
    });
    candidates.sort((p, q) => q.prio - p.prio);
    const placed = [];
    candidates.forEach((c) => {
      const hit = placed.some((p) => Math.abs(c.x - p.x) < (c.lb.w + p.lb.w) / 2 + 6 && Math.abs(c.y - p.y) < (c.lb.h + p.lb.h) / 2);
      if (hit) { hideLabel(c.lb, false, c.x, c.y); return; }
      placed.push(c);
      const el = c.lb.el;
      el.style.visibility = '';
      el.style.transform = 'translate(' + c.x.toFixed(1) + 'px,' + c.y.toFixed(1) + 'px) translate(-50%,-50%)';
      el.style.opacity = c.o.toFixed(2);
      el.tabIndex = 0;
      el.style.pointerEvents = '';
    });
  }

  function hideLabel(lb, offscreen, x, y) {
    const el = lb.el;
    if (x != null) el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%)';
    el.style.opacity = '0';
    el.tabIndex = -1;
    el.style.pointerEvents = 'none';
    if (offscreen) el.style.visibility = 'hidden';
  }

  function render() {
    const g = geom();
    s.finesVisible = g.fineOpacity >= 0.3;
    // 가운데에 걸린 항목: 가장 가까운 눈금 간격의 절반 안에 있을 때만.
    const near = nearestItem();
    s.centerSlot = near.dist <= (s.finesVisible ? 0.5 / FINE : 0.5) ? near.slot : -1;
    s.centerIsTarget = s.centerSlot >= 0 && targetSet[s.level].has(s.centerSlot);
    renderTicks(g);
    renderLabels(g);
    applyScrollBlur();
  }

  function applyScrollBlur() {
    const y = window.scrollY;
    const blur = Math.min(BLUR_MAX, y / 30);
    wheel.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(2) + 'px)' : '';
    wheel.style.opacity = y > 0 ? String(1 - Math.min(0.6, y / 600)) : '';
  }

  function measureLabels() {
    labels.forEach((lb) => { lb.w = lb.el.offsetWidth; lb.h = lb.el.offsetHeight; });
  }

  // ── 움직임 ────────────────────────────────────────────
  function kick() {
    if (s.raf == null) {
      s.lastT = performance.now();
      s.raf = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    s.raf = null;
    const k = Math.min(4, (now - s.lastT) / (1000 / 60));
    s.lastT = now;
    let active = false;

    if (s.flight) {
      active = stepFlight(now) || active;
    } else if (s.arm && !s.drag && !s.wheelTimer) {
      // 섬세하게 멈춘 다른 단계 항목: 정확히 가운데로 붙으며 차오르고, 다 차면 그 항목으로 간다.
      const d = -deltaOf(s.arm.slot);
      s.pos += Math.abs(d) < 0.002 ? d : d * (1 - Math.pow(1 - SNAP, k));
      s.armP = clamp((now - s.arm.start) / ARM_MS, 0, 1);
      if (s.armP >= 1) {
        const slot = s.arm.slot;
        s.arm = null;
        s.armP = 0;
        if (s.level === 0) goIn(slot); else goOut(slot);
      }
      active = true;
    } else if (!s.drag && !s.wheelTimer) {
      if (Math.abs(s.vel) > 0.004 && !reduceMotion) {
        s.pos += s.vel * k;
        s.vel *= Math.pow(FRICTION, k);
        active = true;
      } else {
        s.vel = 0;
        if (s.rotTarget == null) {
          const t = nearestTarget(s.level);
          if (t != null) {
            if (Math.abs(deltaOf(t)) > 0.001) { s.aim = t; s.rotTarget = s.pos - deltaOf(t); }
            else if (t !== s.cur) setCurrent(t);
          }
        }
        if (s.rotTarget != null) {
          const d = s.rotTarget - s.pos;
          if (Math.abs(d) < 0.002 || reduceMotion) {
            s.pos = s.rotTarget;
            s.rotTarget = null;
            if (s.aim >= 0 && s.aim !== s.cur) setCurrent(s.aim);
            s.aim = -1;
          } else {
            s.pos += d * (1 - Math.pow(1 - SNAP, k));
            active = true;
          }
        }
      }
    }

    active = stepStretch(k) || active;
    render();
    if (active) s.raf = requestAnimationFrame(frame);
  }

  // 지난 프레임부터 화면에서 돈 거리를 부풂의 목표로 삼아 스프링으로 따라간다(빠르면 부풀고, 멈추면 되튀며 가라앉는다).
  // 확대·축소 비행에는 이미 맥동(pulse)이 있어서 그만큼 줄인다.
  function stepStretch(k) {
    const movedPx = Math.abs(s.pos - s.prevPos) * geom().unitPx / Math.max(1, k);
    s.prevPos = s.pos;
    if (reduceMotion) { s.stretch = 0; s.stretchVel = 0; return false; }
    const calm = s.flight ? 1 - s.flight.strength : 1;
    const target = clamp(movedPx / STRETCH_FULL_PX, 0, 1) * calm;
    s.stretchVel += (target - s.stretch) * SPRING_K * k;
    s.stretchVel *= Math.pow(SPRING_DAMP, k);
    s.stretch += s.stretchVel * k;
    if (target === 0 && Math.abs(s.stretch) < 0.002 && Math.abs(s.stretchVel) < 0.002) {
      s.stretch = 0;
      s.stretchVel = 0;
      return false;
    }
    return true;
  }

  // 모든 '이동'은 한 번의 비행이다: 원 위에서 가까운 쪽으로 돈다. 단계가 바뀌면(안으로·밖으로) 동시에 0 ↔ 1로 확대·축소한다.
  // 같은 단계의 이동은 멀어도 원이 물러나지 않는다(눈금이 모였다 펼쳐지는 대신, 도는 동안 가운데 눈금이 부푼다: stepStretch).
  // 아래 내용은 비행 한가운데에서 바뀐다(흐려졌다가 도착하며 또렷해진다).
  function flyTo(slot, level) {
    const fromPos = s.pos;
    const toPos = s.pos - deltaOf(slot);
    const fromZ = s.z;
    const toZ = level;
    const levelChange = Math.abs(toZ - fromZ) > 0.5;
    const distPx = Math.abs(toPos - fromPos) * geom().unitPx;
    const dur = levelChange ? ZOOM_MS : Math.min(FLIGHT_MS[2], FLIGHT_MS[0] + distPx * FLIGHT_MS[1]);
    s.level = level;
    s.aim = slot;
    s.vel = 0;
    s.rotTarget = null;
    s.flight = {
      start: performance.now(), dur: reduceMotion ? 0 : dur,
      fromPos: fromPos, toPos: toPos, fromZ: fromZ, toZ: toZ,
      swapSlot: slot !== s.cur ? slot : null, swapped: false,
      strength: clamp(Math.abs(toZ - fromZ), 0, 1),
      pulse: 0
    };
    kick();
  }

  function stepFlight(now) {
    const f = s.flight;
    const t = f.dur > 0 ? clamp((now - f.start) / f.dur, 0, 1) : 1;
    const e = easeInOut(t);
    const arc = Math.sin(Math.PI * t);
    s.pos = lerp(f.fromPos, f.toPos, e);
    s.z = lerp(f.fromZ, f.toZ, e);
    f.pulse = arc * f.strength;
    if (f.swapSlot != null) {
      // 내용: 출발하며 흐려지고, 한가운데에서 바뀌고, 도착하며 또렷해진다.
      const fade = arc;
      page.style.opacity = (1 - fade).toFixed(2);
      page.style.filter = fade > 0.02 ? 'blur(' + (fade * 6).toFixed(1) + 'px)' : '';
      if (!f.swapped && t >= 0.5) { f.swapped = true; setCurrent(f.swapSlot, true); }
    }
    if (t < 1) return true;
    if (f.swapSlot != null && !f.swapped) setCurrent(f.swapSlot, true);
    page.style.opacity = '';
    page.style.filter = '';
    s.pos = f.toPos;
    s.z = f.toZ;
    s.flight = null;
    s.aim = -1;
    return false;
  }

  function cancelFlight() {
    if (!s.flight) return;
    if (s.flight.swapSlot != null && !s.flight.swapped) setCurrent(s.flight.swapSlot, true);
    s.z = s.flight.toZ;
    s.flight = null;
    page.style.opacity = '';
    page.style.filter = '';
  }

  function rotateTo(slot) { flyTo(slot, s.level); }

  // 섬세한 스크롤 판정. log = [{ t, px }] (움직인 거리 px, 시각 ms), endT = 손을 뗀 시각.
  function wasCareful(log, endT) {
    const recentPx = log.filter((q) => endT - q.t < CAREFUL_WINDOW_MS).reduce((acc, q) => acc + q.px, 0);
    return recentPx / CAREFUL_WINDOW_MS < CAREFUL_PX_PER_MS;
  }

  // 가운데가 다른 단계의 항목 눈금 위에 정확히 멈췄으면 차오르기 시작한다.
  // 0단계에선 글 눈금(→ 그 글로 들어간다), 1단계에선 카테고리 눈금(→ 그 카테고리로 나간다).
  function tryArm() {
    const near = nearestItem();
    if (near.dist * geom().unitPx > PRECISE_PX) return false;
    const kind = slots[near.slot].kind;
    if (!(s.level === 0 && kind === 'post') && !(s.level === 1 && kind === 'cat')) return false;
    s.arm = { slot: near.slot, start: performance.now() };
    s.armP = 0;
    s.vel = 0;
    s.rotTarget = null;
    s.aim = -1;
    return true;
  }

  // ── 세 동작 ────────────────────────────────────────────
  // 누르기 = 안으로. 같은 단계의 다른 항목이면 그쪽으로 돌기만 한다.
  function press(slot) {
    if (s.justDragged) return;
    const kind = slots[slot].kind;
    if (kind === 'post') {
      if (s.level === 1) { if (slot !== s.cur) rotateTo(slot); return; }
      goIn(slot);
      return;
    }
    // 홈·카테고리 라벨
    if (s.level === 1) { goOut(slot); return; }
    if (slot !== s.cur && slot !== s.aim) { rotateTo(slot); return; }
    if (kind === 'cat') goIn(postsOf(slots[slot].cat)[0]);
  }

  function goIn(postSlot) {
    if (postSlot == null) return;
    flyTo(postSlot, 1);
  }

  // 나가기 = 밖으로. 글 단계 → 그 글의 카테고리. 카테고리 단계 → 홈.
  function goOut(toSlot) {
    if (s.level === 1) {
      const from = s.flight && s.flight.swapSlot != null ? s.flight.swapSlot : s.cur;
      flyTo(toSlot != null ? toSlot : catSlot[slots[from].cat], 0);
      return;
    }
    if (s.cur !== HOME) rotateTo(HOME);
  }

  // 옆 항목으로. 원이라 끝에서 처음으로 이어진다(취향 다음 = 홈).
  function step(dir) {
    const list = targets[s.level];
    if (!list.length) return;
    const from = s.aim >= 0 ? s.aim : (list.indexOf(s.cur) >= 0 ? s.cur : nearestTarget(s.level));
    const i = (list.indexOf(from) + dir + list.length) % list.length;
    rotateTo(list[i]);
  }

  // ── 아래 내용 ──────────────────────────────────────────
  function setCurrent(slot, instant) {
    s.cur = slot;
    const kind = slots[slot].kind;
    updateHub();
    syncHistory(slot);
    document.title = kind === 'home' ? baseTitle : (kind === 'cat' ? slots[slot].cat : slots[slot].post.title) + ' — ' + data.site;
    countView(slot);
    const show = () => {
      const view = kind === 'post' ? 'post' : kind === 'cat' ? 'cat' : 'home';
      if (view === 'cat') fillCat(slots[slot].cat);
      if (view === 'post') fillPost(slot);
      Object.keys(views).forEach((v) => { views[v].hidden = v !== view; });
      if (window.scrollY > 0) window.scrollTo(0, 0);
    };
    announce(kind === 'home' ? '홈' : kind === 'cat' ? slots[slot].cat : slots[slot].post.title);
    clearTimeout(s.swapTimer);
    if (reduceMotion || instant) { page.classList.remove('is-swapping'); show(); return; }
    page.classList.add('is-swapping');
    s.swapTimer = setTimeout(() => { show(); page.classList.remove('is-swapping'); }, SWAP_MS);
  }

  // 깊어지면 기록을 하나 쌓고, 같은 깊이(옆으로 돌리기)는 덮어쓰고, 얕아지면 실제로 뒤로 간다.
  // 옆으로 돌릴 때마다 기록이 쌓이면 뒤로 가기를 수십 번 눌러야 나갈 수 있어서 덮어쓴다.
  function syncHistory(slot) {
    if (s.historyLock === slot) { s.historyLock = null; return; }
    const depth = depthOf(slot);
    const st = history.state || stateFor(HOME, false);
    if (depth > st.depth) {
      history.pushState(stateFor(slot, true), '', hashFor(slot));
    } else if (depth === st.depth) {
      history.replaceState(stateFor(slot, st.pushed), '', hashFor(slot));
    } else if (st.pushed) {
      // 화면의 '나가기'도 브라우저 뒤로 가기와 같은 기록을 밟게 한다. 도착은 popstate에서 마무리한다.
      s.pendingOut = slot;
      history.back();
    } else {
      // 글 주소로 바로 들어온 경우: 되돌아갈 기록이 없으니 덮어쓴다.
      history.replaceState(stateFor(slot, false), '', hashFor(slot));
    }
  }

  // 브라우저 뒤로/앞으로 가기: 화면의 세 동작과 같은 움직임으로 그 항목에 간다.
  function followHistory(slot) {
    if (slot === s.cur && s.aim < 0) return;
    s.historyLock = slot;
    if (slots[slot].kind === 'post') {
      if (s.level === 1) rotateTo(slot); else goIn(slot);
    } else if (s.level === 1) {
      goOut(slot);
    } else {
      rotateTo(slot);
    }
  }

  window.addEventListener('popstate', (e) => {
    if (s.pendingOut != null) {
      const dest = s.pendingOut;
      s.pendingOut = null;
      const popped = e.state || stateFor(HOME, false);
      // 목록 글을 홈에서 바로 열었던 경우처럼 한 칸 건너 들어왔으면, 나간 자리를 새로 쌓아 둔다.
      if (depthOf(dest) > popped.depth) history.pushState(stateFor(dest, true), '', hashFor(dest));
      else history.replaceState(stateFor(dest, popped.pushed), '', hashFor(dest));
      return;
    }
    // 뒤로 가기는 늘 '지금 있는 곳의 한 단계 밖'이다. 글을 넘기다 다른 카테고리로 건너갔으면
    // 기록에 남은 처음 카테고리가 아니라 지금 글의 카테고리로 나간다.
    const here = s.flight && s.flight.swapSlot != null ? s.flight.swapSlot : s.cur;
    let target = slotFromHash();
    if (e.state && e.state.depth < depthOf(here)) {
      // 홈에서 글로 바로 들어왔던 경우(목록·섬세한 스크롤)도 뒤로 가기 한 번은 카테고리까지만 나간다.
      target = depthOf(here) === 2 ? catSlot[slots[here].cat] : HOME;
      if (depthOf(target) > e.state.depth) history.pushState(stateFor(target, true), '', hashFor(target));
      else if (hashFor(target) !== location.hash) history.replaceState(stateFor(target, e.state.pushed), '', hashFor(target));
    } else if (hashFor(target) !== location.hash) {
      // 없는 글·카테고리 주소(지운 글의 옛 링크 등)는 실제로 간 자리의 주소로 고쳐 둔다.
      history.replaceState(stateFor(target, e.state ? e.state.pushed : false), '', hashFor(target));
    }
    followHistory(target);
  });

  // 사용자가 직접 움직이기 시작하면 뒤로 가기로 가던 목표는 잊는다.
  // 차오르던 항목도 함께 취소한다(다시 손대면 처음부터).
  const dropHistoryLock = () => { s.historyLock = null; s.arm = null; s.armP = 0; };
  document.addEventListener('pointerdown', dropHistoryLock, true);
  document.addEventListener('keydown', dropHistoryLock, true);

  function updateHub() {
    const inPost = slots[s.cur].kind === 'post' && s.level === 1;
    hub.dataset.level = inPost ? '1' : '0';
    hub.replaceChildren();
    if (inPost) {
      hub.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5 L5 3.5 L8 6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      hub.append(document.createTextNode(slots[s.cur].cat));
      hub.setAttribute('aria-label', slots[s.cur].cat + ' 목록으로 나가기');
    } else {
      hub.append(document.createTextNode(data.site));
      hub.setAttribute('aria-label', '홈으로');
    }
  }

  function rowFor(slot) {
    const p = slots[slot].post;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    [['row-date', fmtDate(p.date)], ['row-title', p.title], ['row-cat', p.cat]].forEach((pair) => {
      const span = document.createElement('span');
      span.className = pair[0];
      span.textContent = pair[1];
      btn.appendChild(span);
    });
    btn.addEventListener('click', () => goIn(slot));
    li.appendChild(btn);
    return li;
  }

  // 글이 하나도 없을 때(첫 배포, 빈 카테고리) 목록 자리에 남기는 한 줄.
  function emptyRow(text) {
    const li = document.createElement('li');
    li.className = 'rows-empty';
    li.textContent = text || '아직 글이 없어요';
    return li;
  }

  function fillRows(el, slotList) {
    el.replaceChildren.apply(el, slotList.length ? slotList.map(rowFor) : [emptyRow()]);
  }

  function fillCat(cat) {
    const list = postsOf(cat);
    catTitle.textContent = cat + ' — ' + String(list.length).padStart(2, '0');
    fillRows(catRows, list);
  }

  function fillPost(slot) {
    const p = slots[slot].post;
    postMeta.textContent = [p.cat, p.date ? fmtDate(p.date) : null, p.draft ? '초안' : null].filter(Boolean).join(' · ');
    postTitle.textContent = p.title;
    // 본문 HTML은 build.js가 내 글(posts/*.md)에서 만든 것이라 그대로 넣는다. 남의 입력이 들어오는 자리가 아니다.
    postBody.innerHTML = p.html || '<p class="is-placeholder">[본문]</p>';
    const i = postSlots.indexOf(slot);
    setNav(prevBtn, postSlots[i - 1], '‹ ');
    setNav(nextBtn, postSlots[i + 1], '', ' ›');
  }

  function setNav(btn, slot, before, after) {
    btn.hidden = slot == null;
    if (slot == null) return;
    btn.textContent = (before || '') + slots[slot].post.title + (after || '');
    btn.onclick = () => rotateTo(slot);
  }

  function announce(text) { announcer.textContent = text; }

  // ── 입력: 끌기 ──────────────────────────────────────────
  wheel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.wheel-hub')) return;
    s.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, moved: false, samples: [] };
  });

  wheel.addEventListener('pointermove', (e) => {
    const d = s.drag;
    if (!d || d.id !== e.pointerId) {
      if (e.pointerType === 'mouse') { s.hover = { x: e.clientX, y: e.clientY }; if (s.raf == null) render(); }
      return;
    }
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x0) < 4) return;
      d.moved = true;
      cancelFlight(); // 손으로 잡으면 진행 중인 이동은 그 자리에서 멈춘다
      s.vel = 0;
      s.rotTarget = null;
      s.aim = -1;
      wheel.classList.add('is-dragging');
      try { wheel.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 미지원 브라우저는 그냥 진행 */ }
    }
    const g = geom();
    const delta = (e.clientX - d.x) / g.unitPx; // 원이라 끝이 없다: 저항 없이 계속 돈다
    s.pos += delta;
    d.x = e.clientX;
    d.samples.push({ t: e.timeStamp, d: delta, px: Math.abs(delta) * g.unitPx });
    if (d.samples.length > 8) d.samples.shift();
    s.hover = { x: e.clientX, y: e.clientY };
    kick(); // 그리기는 프레임에서: 부풂 스프링이 같은 박자로 돈다
  });

  function endDrag(e) {
    const d = s.drag;
    if (!d || d.id !== e.pointerId) return;
    s.drag = null;
    wheel.classList.remove('is-dragging');
    if (d.moved) {
      // 마지막 80ms의 속도를 이어받아 관성으로 돈다.
      const recentMoves = d.samples.filter((q) => e.timeStamp - q.t < 80);
      if (recentMoves.length > 1) {
        const span = Math.max(1, recentMoves[recentMoves.length - 1].t - recentMoves[0].t);
        const sum = recentMoves.slice(1).reduce((acc, q) => acc + q.d, 0);
        const maxVel = 30 / geom().unitPx; // 프레임당 최대 30px
        s.vel = clamp(sum / span * (1000 / 60), -maxVel, maxVel);
      }
      // 천천히 끌어 다른 단계의 눈금에 정확히 맞췄으면 관성 대신 차오르기.
      if (wasCareful(d.samples, e.timeStamp)) tryArm();
      // 끌기 끝에 따라오는 click이 라벨을 누르지 않게 한 번 막는다.
      s.justDragged = true;
      setTimeout(() => { s.justDragged = false; }, 0);
    } else if (e.type === 'pointerup' && !e.target.closest('.label')) {
      // 끌지 않고 호 위를 눌렀으면, 누른 자리에서 가까운 같은 단계 항목으로 돈다.
      const g = geom();
      const a = deg(Math.asin(clamp((e.clientX - g.cx) / g.R, -1, 1)));
      const at = a / g.stepDeg; // 누른 자리(가운데 기준 칸)
      let best = -1, bd = 32 / g.unitPx;
      targets[s.level].forEach((i) => { const dd = Math.abs(deltaOf(i) - at); if (dd < bd) { bd = dd; best = i; } });
      if (best >= 0) press(best);
    }
    kick();
  }
  wheel.addEventListener('pointerup', endDrag);
  wheel.addEventListener('pointercancel', endDrag);
  wheel.addEventListener('pointerleave', () => { s.hover = null; if (s.raf == null) render(); });

  // ── 입력: 휠·트랙패드·핀치 ───────────────────────────────
  wheel.addEventListener('wheel', (e) => {
    e.preventDefault(); // 휠 위에서는 페이지 대신 휠이 움직인다
    dropHistoryLock();
    if (e.ctrlKey) {
      // 트랙패드 핀치(브라우저가 ctrl+휠로 보낸다): 벌리면 안으로, 오므리면 밖으로.
      if (s.pinchLock) return;
      s.pinch += e.deltaY;
      if (Math.abs(s.pinch) < PINCH_STEP) return;
      const out = s.pinch > 0;
      s.pinch = 0;
      s.pinchLock = true;
      setTimeout(() => { s.pinchLock = false; }, 500);
      if (out) goOut();
      else if (s.level === 0 && slots[s.cur].kind === 'cat') goIn(postsOf(slots[s.cur].cat)[0]);
      return;
    }
    const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
    if (delta === 0) return;
    // ponytail: 휠/트랙패드 구분은 휴리스틱(줄 단위이거나 50px 이상의 정수 델타 = 마우스 휠). 오판이 보이면 이벤트 간격으로 판정한다.
    if (e.deltaMode === 1 || (Math.abs(delta) >= 50 && Number.isInteger(delta))) {
      step(Math.sign(delta));
      return;
    }
    cancelFlight();
    s.pos -= delta / geom().unitPx;
    s.vel = 0;
    s.rotTarget = null;
    s.aim = -1;
    s.wheelLog.push({ t: e.timeStamp, px: Math.abs(delta) });
    if (s.wheelLog.length > 40) s.wheelLog.shift();
    kick(); // 그리기는 프레임에서(wheelTimer가 걸려 있는 동안 프레임은 pos를 건드리지 않는다)
    clearTimeout(s.wheelTimer);
    s.wheelTimer = setTimeout(() => {
      s.wheelTimer = null;
      if (wasCareful(s.wheelLog, performance.now())) tryArm();
      s.wheelLog = [];
      kick();
    }, WHEEL_IDLE_MS);
  }, { passive: false });

  // ── 입력: 키보드 ────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // 도움말 같은 창이 떠 있으면 Esc·화살표는 그 창의 것이다(휠이 나가거나 돌지 않게).
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      goOut();
    } else if (e.key === 'Enter' && (document.activeElement === document.body || !document.activeElement)) {
      // 초점이 단추에 있으면 그 단추가 Enter를 받는다. 아무 데도 없을 때만 '지금 항목 안으로'.
      if (s.level === 0 && slots[s.cur].kind === 'cat') { e.preventDefault(); goIn(postsOf(slots[s.cur].cat)[0]); }
    }
  });

  hub.addEventListener('click', () => goOut());

  // ── 방문 집계(GoatCounter) ────────────────────────────────
  // 세는 쪽은 index.html의 count.js, 읽는 쪽은 공개 카운터(사이트 설정 'Allow adding visitor counts'가 켜져 있어야 한다).
  // 카운터 응답은 GoatCounter가 최대 4시간 캐시한다: 방금 들어온 방문은 늦게 보인다.
  const GC_SITE = 'https://cihwang6870.goatcounter.com';

  // 집계 경로는 주소에서 #만 뺀 꼴(사람이 읽는 한글 그대로): / · /공부 · /공부/휠을-만들며
  function statPathFor(slot) {
    const x = slots[slot];
    if (x.kind === 'home') return '/';
    return '/' + x.cat + (x.kind === 'post' ? '/' + x.post.slug : '');
  }

  // 주소가 #/… 라 count.js가 저절로 세면 모든 조회가 '/' 하나로 쌓인다. 화면이 바뀔 때마다 직접 센다.
  function countView(slot) {
    const send = () => window.goatcounter.count({ path: statPathFor(slot), title: document.title });
    if (window.goatcounter && window.goatcounter.count) { send(); return; }
    // count.js가 아직 오는 중이면 도착하면 센다. 광고 차단 등으로 못 오면 세지 않는다(화면에는 영향 없음).
    const script = document.querySelector('script[data-goatcounter]');
    if (script) script.addEventListener('load', send, { once: true });
  }

  // 공개 카운터 하나. 한 번도 열리지 않은 경로는 404 → 0. count는 '1,234'처럼 쉼표가 든 문자열로 온다.
  async function fetchStat(path, startDate) {
    const url = GC_SITE + '/counter/' + encodeURIComponent(path) + '.json' + (startDate ? '?start=' + startDate : '');
    const res = await fetch(url);
    if (res.status === 404) return 0;
    if (!res.ok) throw new Error('GoatCounter ' + path + ' ' + res.status);
    return Number(String((await res.json()).count).replace(/\D/g, ''));
  }

  async function loadVisitStats() {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD(서울)
    try {
      const both = await Promise.all([fetchStat('TOTAL', today), fetchStat('TOTAL')]);
      visitsTodayEl.textContent = both[0].toLocaleString('ko-KR');
      visitsTotalEl.textContent = both[1].toLocaleString('ko-KR');
    } catch (err) {
      console.warn('[blog] 방문자 수를 불러오지 못했어요', err);
    }
    // ponytail: 글마다 카운터를 한 번씩 부른다(글 수만큼 요청). 글이 수백 편이 되면 빌드 때 GoatCounter API로 한 번에 받아 posts.json에 넣는다.
    try {
      const counts = await Promise.all(postSlots.map((i) => fetchStat(statPathFor(i))));
      const top = postSlots.map((slot, k) => ({ slot: slot, n: counts[k] })).filter((p) => p.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
      if (!top.length) { popularEl.replaceChildren(emptyRow('아직 집계된 글이 없어요')); return; }
      popularEl.replaceChildren.apply(popularEl, top.map((p, rank) => {
        const li = rowFor(p.slot);
        li.querySelector('.row-date').textContent = String(rank + 1).padStart(2, '0');
        li.querySelector('.row-cat').textContent = p.n.toLocaleString('ko-KR') + '회';
        return li;
      }));
    } catch (err) {
      console.warn('[blog] 많이 읽힌 글을 불러오지 못했어요', err);
      popularEl.replaceChildren(emptyRow('조회수를 불러오지 못했어요'));
    }
  }

  // ── 기타 ─────────────────────────────────────────────
  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' });
  }

  window.addEventListener('scroll', applyScrollBlur, { passive: true });
  window.addEventListener('resize', render);

  fillRows(recentEl, recent.slice(0, 5));
  loadVisitStats();
  measureLabels();
  // 주소로 바로 들어와도(새로고침·공유 링크) 그 자리에서 시작한다.
  const start = slotFromHash();
  history.replaceState(stateFor(start, false), '', hashFor(start));
  if (start !== HOME) {
    if (slots[start].kind === 'post') { s.level = 1; s.z = 1; }
    s.pos = -slots[start].u;
    s.prevPos = s.pos; // 첫 프레임이 시작 위치로의 점프를 '빠른 회전'으로 잘못 재지 않게
    setCurrent(start, true);
  } else {
    updateHub();
    countView(HOME);
  }
  render();
  tickClock();
  setInterval(tickClock, 30000);
  // 웹 글꼴이 늦게 오면 라벨 크기가 바뀌므로 다시 잰다.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureLabels(); render(); });
})();
