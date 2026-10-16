/**
 * 글쓰기 화면 파일들(app.js·screen-list.js·screen-editor.js)이 같이 쓰는 DOM 도우미와 사이트 글 목록 받기.
 * 화면 파일이 app.js를 다시 import하면 순환 의존이 생겨서, 같이 쓰는 것은 이 파일에만 둔다.
 */
import { SITE_URL } from './config.js';
import { ConflictError } from './github.js';
import { createLocal } from './local.js';

const CONFLICT_TEXT = '다른 기기에서 먼저 저장했어요. 덮어쓰지 않았고, 이 기기 내용은 그대로 남겨 뒀어요.';
const app = document.querySelector('[data-role="app"]');

/** 쓰던 글의 기기 안 저장본. 상태가 없는 localStorage 감싸개라 화면들이 하나를 같이 쓴다. */
export const local = createLocal();

/** `root` 안에서 `data-role`이 `role`인 첫 요소. */
export const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

/** 글 편집 주소. `repo`는 `'drafts'|'blog'`, `path`는 저장소 안 `posts/…md`. */
export const editHash = (repo, path) => `#/edit?repo=${repo}&path=${encodeURIComponent(path)}`;

/** 오류를 상태 글에 쓸 해요체 문장으로. 충돌은 덮어쓰지 않았다는 안내로 바꾼다. */
export const failText = (e) => (e instanceof ConflictError ? CONFLICT_TEXT : e.message);

/** write.html의 `<template data-tpl=name>` 첫 요소를 복제한다. */
export function cloneTemplate(name) {
  return document.querySelector(`template[data-tpl="${name}"]`).content.firstElementChild.cloneNode(true);
}

/** 템플릿을 복제해 화면 전체(`[data-role="app"]`)를 그것으로 바꾸고, 복제한 요소를 돌려준다. */
export function mount(name) {
  const node = cloneTemplate(name);
  app.replaceChildren(node);
  return node;
}

/**
 * 카테고리 알약(라디오 묶음)을 만든다. 라디오는 알약 위에 투명하게 덮여 누르기·방향키·초점을 기본 라디오 그대로 쓴다.
 * @param {string} name 라디오 묶음 이름. 한 화면에 묶음이 둘이면 서로 달라야 한다.
 * @param {string[]} categories 휠 순서의 카테고리 이름
 * @param {string|undefined} checked 골라 둘 이름. 목록에 없으면 아무것도 고르지 않는다.
 * @returns {HTMLLabelElement[]} `.ed-pill` 라벨들(이름은 textContent로 넣는다)
 */
export function categoryPills(name, categories, checked) {
  return categories.map((c) => {
    const label = document.createElement('label');
    label.className = 'ed-pill';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name, value: c, checked: c === checked });
    const text = document.createElement('span');
    text.textContent = c;
    label.append(input, text);
    return label;
  });
}

/**
 * `renderMarkdown`으로 그린 칸(미리보기·도움말) 안 링크의 click을 처리한다.
 * 각주·제목(`#…`)은 그 칸 안에서 움직이고, http(s) 주소는 새 탭으로 연다. 이 페이지 주소(`#/…`)는 바꾸지 않는다.
 * @param {HTMLElement} container 링크를 담은 칸. `#…`의 대상도 이 안에서만 찾는다.
 * @param {MouseEvent} e 그 칸의 click 이벤트. 링크를 누른 것이면 기본 동작을 막는다.
 */
export function followRenderedLink(container, e) {
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href.startsWith('#')) {
    let target = href.slice(1);
    try {
      target = decodeURIComponent(target);
    } catch {
      // 깨진 %인코딩이면 적힌 그대로의 id를 찾는다.
    }
    container.querySelector(`[id="${CSS.escape(target)}"]`)?.scrollIntoView();
  } else if (link.protocol === 'http:' || link.protocol === 'https:') {
    // 토큰이 있는 페이지라 javascript: 같은 다른 주소는 열지 않는다.
    window.open(link.href, '_blank', 'noopener');
  }
}

/** 화면의 `[data-role="notices"]`에 안내 한 줄을 더한다(그 칸은 role="alert"라 읽어 준다). */
export function addNotice(root, text) {
  const p = document.createElement('p');
  p.className = 'ed-notice';
  p.textContent = text;
  $(root, 'notices').append(p);
}

/**
 * 사이트에 지금 공개된 글들(`posts.json`). 배포 캐시를 피하려고 시각을 붙인다.
 * @returns {Promise<{ path: string, cat: string, slug: string, title: string, html: string }[]>}
 * @throws {Error} 네트워크 실패, HTTP 오류, 깨진 JSON일 때(해요체 메시지)
 */
export async function fetchLive() {
  let res;
  try {
    res = await fetch(`${SITE_URL}posts.json?t=${Date.now()}`, { cache: 'no-store' });
  } catch {
    throw new Error('사이트 글 목록(posts.json)을 불러오지 못했어요. 네트워크를 확인해 주세요.');
  }
  if (!res.ok) throw new Error(`사이트 글 목록(posts.json)을 불러오지 못했어요. (HTTP ${res.status})`);
  try {
    const { posts = [] } = await res.json();
    return posts;
  } catch (e) {
    throw new Error('사이트 글 목록(posts.json)을 읽지 못했어요. 배포가 덜 끝났을 수 있어요.', { cause: e });
  }
}
