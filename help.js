/**
 * 글쓰기 도움말 모달. 어느 화면에서든 ? 키(또는 오른쪽 아래 ? 단추)로 지금 화면 위에 띄운다.
 * 내용은 posts/_글쓰기-도움말.md → build.js --drafts → posts.json의 help. 배포본(build.js)에는 help가 없어서
 * 방문자에게는 단추도 창도 생기지 않는다. 글 목록은 wheel.js가 불러오고 postsloaded로 넘겨준다.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isTyping = (el) => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));

  document.addEventListener('postsloaded', (e) => {
    const help = e.detail && e.detail.help;
    if (!help) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-btn';
    btn.textContent = '?';
    btn.setAttribute('aria-label', '글쓰기 도움말 열기 (? 키)');

    const dlg = document.createElement('dialog');
    dlg.className = 'help';
    dlg.setAttribute('aria-labelledby', 'help-title');
    const head = document.createElement('div');
    head.className = 'help-head';
    const title = document.createElement('h2');
    title.id = 'help-title';
    title.className = 'help-title';
    title.textContent = help.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-close';
    close.textContent = '닫기';
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'help-body post-body';
    // 내 글(posts/_글쓰기-도움말.md)을 build.js가 만든 HTML이라 그대로 넣는다.
    body.innerHTML = help.html;
    dlg.append(head, body);
    document.body.append(btn, dlg);

    const open = () => { if (!dlg.open) dlg.showModal(); };
    btn.addEventListener('click', open);
    close.addEventListener('click', () => dlg.close());
    // 창 바깥(어두운 배경)을 누르면 닫는다.
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== '?' || ev.ctrlKey || ev.metaKey || ev.altKey || isTyping(ev.target)) return;
      ev.preventDefault();
      if (dlg.open) dlg.close(); else open();
    });
    // 도움말 안의 목차 링크·각주는 창 안에서만 움직인다(주소를 바꾸면 휠이 홈으로 가 버린다).
    body.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[href^="#"]');
      if (!a) return;
      ev.preventDefault();
      const target = body.querySelector('[id="' + CSS.escape(decodeURIComponent(a.getAttribute('href').slice(1))) + '"]');
      if (target) target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });
})();
