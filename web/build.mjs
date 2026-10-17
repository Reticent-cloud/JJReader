// 鲸鲸阅读器前端打包脚本：esbuild 把 src/index.js 打成单个 IIFE 产物 dist/md-engine.js。
// Task 1 只做最小实现；后续任务会在此加入 CSS 内联等能力。

import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(root, 'dist/md-engine.js');
const MAX_BYTES = 500 * 1024;

mkdirSync(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/index.js')],
  outfile,
  bundle: true,
  format: 'iife',
  minify: false,
  logLevel: 'warning',
});

const bytes = statSync(outfile).size;
const kb = (bytes / 1024).toFixed(1);
if (bytes > MAX_BYTES) {
  throw new Error(`md-engine.js 体积 ${kb} KB，超过 500 KB 上限`);
}
console.log(`md-engine.js ${kb} KB → dist/md-engine.js`);
