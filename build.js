/**
 * posts/ 아래 마크다운 글을 읽어 posts.json 하나로 만든다. 화면(index.html + wheel.js)은 이 파일만 읽는다.
 *
 *   node build.js            배포용: 초안(draft: true)과 글쓰기 도움말 제외
 *   node build.js --drafts   로컬 미리보기용: 초안 + 글쓰기 도움말(help) 포함(serve.py가 이걸로 돌린다)
 *
 * 글 파일 규칙(자세한 건 posts/_글쓰기-도움말.md, 미리보기에서 ? 키):
 *   - posts/ 아래 아무 폴더에 *.md. 이름이 _ 로 시작하는 파일·폴더는 건너뛴다(템플릿 등).
 *   - 맨 위 --- 사이에 title(필수), category(site.json의 카테고리 중 하나, 필수), date(YYYY-MM-DD), slug, draft.
 *   - 사진·GIF·영상은 media/ 에 두고 ![설명](../media/파일) 로 넣는다(편집기 미리보기에서도 보이게 ../ 를 붙인다).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import markedFootnote from 'marked-footnote';
import { gfmHeadingId, resetHeadings } from 'marked-gfm-heading-id';
import markedKatex from 'marked-katex-extension';
import { markedEmoji } from 'marked-emoji';
import { nameToEmoji } from 'gemoji';

// 경로에 한글이 있어도 깨지지 않게 fileURLToPath로 푼다(URL.pathname은 %ED… 로 남는다).
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const POSTS_DIR = join(ROOT, 'posts');
const OUT = join(ROOT, 'posts.json');
const withDrafts = process.argv.includes('--drafts');

const config = JSON.parse(readFileSync(join(ROOT, 'site.json'), 'utf8'));

// ── 마크다운 → HTML ───────────────────────────────────────
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

// ── 글 파일 읽기 ─────────────────────────────────────────
function listMarkdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('_') || name.startsWith('.')) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listMarkdown(full);
    return name.toLowerCase().endsWith('.md') ? [full] : [];
  });
}

// 맨 위 --- 사이의 "키: 값" 줄만 읽는다(따옴표는 벗긴다).
function splitFrontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  });
  return { meta, body: text.slice(m[0].length) };
}

const errors = [];
const posts = [];

listMarkdown(POSTS_DIR).forEach((file) => {
  const where = relative(ROOT, file);
  const { meta, body } = splitFrontMatter(readFileSync(file, 'utf8'));
  const draft = meta.draft === 'true';
  if (draft && !withDrafts) return;
  if (!meta.title) errors.push(where + ': title이 없어요');
  if (!config.categories.includes(meta.category)) errors.push(where + ': category "' + (meta.category || '') + '"는 site.json에 없어요 (' + config.categories.join(', ') + ')');
  if (meta.date && !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) errors.push(where + ': date는 YYYY-MM-DD 형식이어야 해요 (지금: ' + meta.date + ')');
  const slug = meta.slug || basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  resetHeadings();
  posts.push({
    cat: meta.category,
    title: meta.title,
    date: meta.date || '',
    slug: slug,
    draft: draft,
    html: body.trim() ? marked.parse(body) : '',
    file: where
  });
});

// 같은 카테고리 안에서 주소(slug)가 겹치면 링크가 엉킨다.
const seen = new Set();
posts.forEach((p) => {
  const key = p.cat + '/' + p.slug;
  if (seen.has(key)) errors.push(p.file + ': 같은 카테고리에 slug "' + p.slug + '"가 이미 있어요');
  seen.add(key);
});

if (errors.length) {
  console.error('글 목록을 만들지 못했어요:\n- ' + errors.join('\n- '));
  process.exit(1);
}

// 휠 위 순서: 카테고리 안에서 오래된 글 → 최근 글. 날짜 없는 글은 뒤로, 그 안에선 파일 이름 순.
posts.sort((a, b) => {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (!a.date !== !b.date) return a.date ? -1 : 1;
  return a.file < b.file ? -1 : 1;
});
posts.forEach((p) => { delete p.file; });

// 글쓰기 도움말: 로컬 미리보기에서만 ? 키 모달로 띄운다(help.js). 배포본에는 넣지 않는다.
let help = null;
if (withDrafts) {
  const { meta, body } = splitFrontMatter(readFileSync(join(POSTS_DIR, '_글쓰기-도움말.md'), 'utf8'));
  resetHeadings();
  help = { title: meta.title || '글쓰기 도움말', html: marked.parse(body) };
}

writeFileSync(OUT, JSON.stringify({ site: config.site, categories: config.categories, posts: posts, help: help }));
console.log('posts.json: 글 ' + posts.length + '편' + (withDrafts ? ' (초안 포함)' : ''));
