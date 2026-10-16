/**
 * 오른쪽 위 해와 달 = 화이트/블랙 전환. 휠(wheel.js)과 따로 둬서 글 목록을 못 불러와도 테마는 바뀐다.
 *
 * 누를 때마다 궤도가 같은 방향으로 반 바퀴씩 돈다(해가 지고 달이 뜬다 → 달이 지고 해가 뜬다).
 * 블랙으로: 밝은 화면이 해 쪽으로 오므라들며 빨려 들어간다(빛을 빼앗기).
 * 화이트로: 해에서 밝은 화면이 원으로 퍼져 나온다(빛을 돌려주기).
 * 고른 값은 이 브라우저에 기억하고, 아직 고르지 않았으면 운영체제 설정이 바뀔 때 따라간다.
 * 테마가 바뀌면 themechange를 알린다(wheel.js가 눈금 색을 다시 읽는다).
 */
(() => {
  'use strict';

  const SKY_SWAP_MS = 610;         // 해가 지평선에 닿는 즈음. styles.css의 궤도 회전 시간(1.6초)과 함께 움직인다
  const SKY_SWEEP_DELAY_MS = 60;   // 눌러서 해가 움직이기 시작한 뒤 빛이 움직이기까지
  const LIGHT_ABSORB_MS = 900;     // 빛이 해로 빨려 들어가는 시간. styles.css light-absorb와 같은 값

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const docEl = document.documentElement;
  const sky = document.querySelector('[data-role="sky"]');
  const skyOrbit = document.querySelector('[data-role="sky-orbit"]');
  let skyTurns = docEl.dataset.theme === 'dark' ? 1 : 0;
  let skyTimer = null;

  function paintSky() {
    skyOrbit.style.transform = 'rotate(' + skyTurns * 180 + 'deg)';
    sky.setAttribute('aria-label', skyTurns % 2 === 1 ? '화이트로 바꾸기' : '블랙으로 바꾸기');
  }

  function applyTheme(theme) {
    docEl.dataset.theme = theme;
    document.dispatchEvent(new Event('themechange'));
  }

  function toggleTheme() {
    skyTurns += 1;
    paintSky();
    const theme = skyTurns % 2 === 1 ? 'dark' : 'light';
    try { localStorage.setItem('theme', theme); } catch (err) { /* 저장 못 해도 이번 방문엔 적용된다 */ }
    clearTimeout(skyTimer);
    if (reduceMotion) { applyTheme(theme); return; }
    if (document.startViewTransition) {
      skyTimer = setTimeout(() => sweepTheme(theme), SKY_SWEEP_DELAY_MS);
      return;
    }
    // View Transitions가 없는 브라우저: 해가 지평선에 닿을 즈음 색만 부드럽게 바꾼다.
    skyTimer = setTimeout(() => applyTheme(theme), SKY_SWAP_MS);
  }

  // 원의 중심 = 해와 달 아이콘의 가운데, 끝 반지름 = 거기서 가장 먼 화면 모서리까지(styles.css가 --sky-x/y/r로 쓴다).
  function sweepTheme(theme) {
    const r = sky.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const far = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    docEl.style.setProperty('--sky-x', x.toFixed(1) + 'px');
    docEl.style.setProperty('--sky-y', y.toFixed(1) + 'px');
    docEl.style.setProperty('--sky-r', Math.ceil(far) + 'px');
    docEl.dataset.sweep = theme === 'dark' ? 'absorb' : 'return';
    // 쓸고 지나가는 동안 색 전환(transition)이 끼면 새 화면이 옛 색으로 찍힌다. 그동안만 끈다.
    docEl.classList.add('is-theme-sweeping');
    // 빛이 다 빨려 들어오는 순간(빼앗기) / 퍼지기 시작하는 순간(돌려주기) 아이콘이 살짝 부푼다.
    sky.classList.remove('is-pulsing');
    setTimeout(() => {
      void sky.offsetWidth; // 연달아 눌러도 부풂이 처음부터 다시 돌게 레이아웃을 한 번 읽는다
      sky.classList.add('is-pulsing');
    }, theme === 'dark' ? LIGHT_ABSORB_MS - 120 : 0);
    const t = document.startViewTransition(() => applyTheme(theme));
    t.finished.finally(() => {
      docEl.classList.remove('is-theme-sweeping');
      delete docEl.dataset.sweep;
    });
  }

  sky.addEventListener('click', toggleTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch (err) { /* 저장소를 못 쓰면 운영체제 설정을 따른다 */ }
    if (saved) return;
    if ((skyTurns % 2 === 1) !== e.matches) { skyTurns += 1; paintSky(); }
    applyTheme(e.matches ? 'dark' : 'light');
  });
  paintSky();
  // 처음 그릴 때는 돌지 않게, 그다음부터 회전 전환을 켠다.
  requestAnimationFrame(() => requestAnimationFrame(() => sky.classList.add('is-ready')));
})();
