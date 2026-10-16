/**
 * 마크다운 → HTML 설정과 글 머리말 읽기. build.js(Node)와 에디터(브라우저)가 같이 쓴다.
 * 브라우저에서도 import map으로 읽히므로 node: 모듈을 쓰지 않는다.
 */
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import markedFootnote from 'marked-footnote';
import { gfmHeadingId, resetHeadings } from 'marked-gfm-heading-id';
import markedKatex from 'marked-katex-extension';
import { markedEmoji } from 'marked-emoji';
import { nameToEmoji } from 'gemoji';

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const YOUTUBE = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/i;

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 글 폴더(posts/…)에서 편집기 미리보기용으로 쓴 ../media/ 를 사이트 기준 media/ 로 바꾼다.
const mediaUrl = (href) => href.replace(/^(\.\.\/)+media\//, 'media/');

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  }),
  markedFootnote({ description: '각주' }),
  gfmHeadingId({ prefix: 'h-' }),
  markedKatex({ throwOnError: false, nonStandard: true }),
  markedEmoji({ emojis: nameToEmoji, renderer: (token) => token.emoji }),
  {
    renderer: {
      // 그림 문법 하나로 사진·GIF·영상·유튜브를 모두 넣는다. "제목"을 쓰면 아래 설명(캡션)이 된다.
      image({ href, title, text }) {
        const caption = title ? '<figcaption>' + escapeAttr(title) + '</figcaption>' : '';
        const yt = YOUTUBE.exec(href);
        if (yt) {
          return '<figure class="media media-embed"><iframe src="https://www.youtube-nocookie.com/embed/' + yt[1] +
            '" title="' + escapeAttr(text || title || 'YouTube 영상') + '" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>' + caption + '</figure>';
        }
        const [path, flag] = mediaUrl(href).split('#');
        if (VIDEO.test(path)) {
          // #loop: GIF처럼 소리 없이 자동 반복. 없으면 재생 단추가 있는 보통 영상.
          const attrs = flag === 'loop' ? 'autoplay muted loop playsinline' : 'controls playsinline preload="metadata"';
          return '<figure class="media"><video src="' + escapeAttr(path) + '" ' + attrs + ' aria-label="' + escapeAttr(text) + '"></video>' + caption + '</figure>';
        }
        return '<figure class="media"><img src="' + escapeAttr(path) + '" alt="' + escapeAttr(text) + '" loading="lazy" decoding="async">' + caption + '</figure>';
      }
    }
  }
);

/**
 * 마크다운 본문을 HTML로 만든다. 제목 id 번호는 글마다 새로 센다.
 * @param {string} body 머리말을 뗀 본문. 공백뿐이면 빈 문자열을 돌려준다.
 * @returns {string} 글 한 편의 HTML
 */
export function renderMarkdown(body) {
  resetHeadings();
  return body.trim() ? marked.parse(body) : '';
}

// 맨 위 --- 사이의 "키: 값" 줄만 읽는다(따옴표는 벗긴다).
export function splitFrontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  });
  return { meta, body: text.slice(m[0].length) };
}

/**
 * 글 파일 경로에서 주소(slug)를 만든다: 마지막 `/` 뒤 이름에서 `.md`와 앞의 `YYYY-MM-DD-`를 뗀다.
 * @param {string} path `/` 로 구분한 경로
 */
export function slugFromPath(path) {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}
