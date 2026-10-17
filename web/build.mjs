// 鲸鲸阅读器前端打包脚本：esbuild 把 src/index.js 打成单个 IIFE 产物 dist/md-engine.js。
// CSS 内联：web/src/styles/*.css 排序拼接后经 banner 注入为 window.__JJ_CSS_TEXT__（在 bundle 执行前生效），
// 由 src/index.js 的 applyCss 在 install() 时写入 <style data-jj>；styles 目录不存在时注入空串。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(root, 'dist/md-engine.js');
const stylesDir = resolve(root, 'src/styles');
const MAX_BYTES = 500 * 1024;

function readCssText() {
  if (!existsSync(stylesDir)) {
    return '';
  }
  return readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => readFileSync(join(stylesDir, name), 'utf8'))
    .join('\n');
}

const cssText = readCssText();

mkdirSync(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/index.js')],
  outfile,
  bundle: true,
  format: 'iife',
  minify: false,
  // .css 按文本处理：后续任务直接在 JS 里 import css 也得拿到字符串，而不是让 esbuild 报无 loader。
  loader: { '.css': 'text' },
  // banner 在 bundle（含自动 install）之前执行，因此 install() 里能读到内联的 CSS 文本。
  banner: { js: `window.__JJ_CSS_TEXT__ = ${JSON.stringify(cssText)};` },
  logLevel: 'warning',
});

const bytes = statSync(outfile).size;
const kb = (bytes / 1024).toFixed(1);
if (bytes > MAX_BYTES) {
  throw new Error(`md-engine.js 体积 ${kb} KB，超过 500 KB 上限`);
}
console.log(`md-engine.js ${kb} KB → dist/md-engine.js（内联 CSS ${cssText.length} 字符）`);
