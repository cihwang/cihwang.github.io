// highlight.js의 ESM 진입점(es/index.js)은 CommonJS lib/index.js를 다시 불러서 브라우저에서 못 쓴다.
// 그래서 core.js(require 없음)를 ESM으로 감싸고, 언어는 lib/index.js와 같은 목록으로 es/languages에서 등록한 모듈을 만든다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 브라우저용 highlight.js ESM 모듈의 소스를 만든다(파일은 쓰지 않는다).
 * @param nodeModulesDir 프로젝트 루트 기준 node_modules 경로. 결과 모듈은 vendor/ 아래에 놓인다고 가정하고 `../` 로 가리킨다.
 * @returns 기본 내보내기가 hljs 인스턴스인 ESM 소스. 언어 목록은 Node의 lib/index.js와 같다.
 */
export function generateHighlightModule(nodeModulesDir) {
  const core = readFileSync(`${nodeModulesDir}/highlight.js/lib/core.js`, 'utf8');
  const index = readFileSync(`${nodeModulesDir}/highlight.js/lib/index.js`, 'utf8');
  const langs = [...index.matchAll(/registerLanguage\('([^']+)', require\('\.\/languages\/([^']+)'\)\)/g)];

  const imports = langs.map(([, , file], i) => `import l${i} from '../${nodeModulesDir}/highlight.js/es/languages/${file}.js';`);
  const registers = langs.map(([, name], i) => `module.exports.registerLanguage(${JSON.stringify(name)}, l${i});`);

  return [
    '// tools/vendor.js가 만든 파일. 직접 고치지 않는다.',
    ...imports,
    'const module = { exports: {} };',
    core,
    ...registers,
    'export default module.exports;',
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync('vendor', { recursive: true });
  writeFileSync('vendor/highlight.js', generateHighlightModule('node_modules'));
  console.log('vendor/highlight.js 생성');
}
