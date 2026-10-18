// Task 17：性能冒烟（spec §9.1「性能冒烟」/ §10 预算）。
// 口径（brief + Controller 决策）：
//   - 5 万行 Markdown 是验收文档规模；splitBlocks 必须零丢失且耗时 < 300 ms（jsdom 宽阈值防抖动）；
//   - extractHeadings（大文档首屏预扫描）< 300 ms；
//   - 前端产物 web/dist/md-engine.js ≤ 640 KB，产物缺失时给出「先 npm run build」的明确失败信息。
// 说明：这些是回归护栏，不是基准测试——阈值按 spec 的宽口径，不追求贴边。

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const PRODUCTION_LIMIT_BYTES = 640 * 1024;

/**
 * 产物路径：vitest 的 root 是 web/，因此 cwd/dist 就是 web/dist；
 * 从仓库根直接跑 vitest 时退到 web/dist。import.meta.url 在 vitest+jsdom 下不是 file: URL，不能用来定位。
 */
function artifactPath() {
  const candidates = [resolve(process.cwd(), 'dist/md-engine.js'), resolve(process.cwd(), 'web/dist/md-engine.js')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** 5 万行验收文档（用例间复用，避免重复构造与 GC 抖动）。 */
let cachedDoc = null;
function hugeDoc() {
  if (cachedDoc === null) {
    cachedDoc = Array.from({ length: 50000 }, (_, i) => `第 ${i} 行内容`).join('\n');
  }
  return cachedDoc;
}

describe('性能冒烟：5 万行文档', () => {
  it('5 万行文档切块耗时可控且零丢失', () => {
    const markdown = hugeDoc();
    const started = performance.now();
    const { blocks } = JJ.splitBlocks(markdown);
    const elapsedMs = performance.now() - started;
    expect(blocks.join('')).toBe(markdown);
    expect(elapsedMs).toBeLessThan(300);
  });

  it('5 万行文档 extractHeadings 预扫描耗时 < 300 ms', () => {
    const markdown = hugeDoc();
    const started = performance.now();
    const headings = JJ.extractHeadings(markdown);
    const elapsedMs = performance.now() - started;
    expect(headings).toEqual([]); // 全文没有标题行：预扫描本身仍要跑完
    // 300 ms 是宽松上限（慢机/CI 余量；本机实测约 46 ms），避免抖动导致 flaky，不是性能预算。
    expect(elapsedMs).toBeLessThan(300);
  });

  it('前 256 KB 文档 renderMarkdown 耗时 < 1000 ms（宽松护栏，非预算门禁）', () => {
    // 首屏预算口径是 256 KB HTML/正文：这里直接渲染 5 万行样例的前 256 KB（jsdom 含清洗/高亮）。
    // 1000 ms 只是「渲染器没有退化成 O(n²)/卡死」的回归护栏；真实首屏预算由 verify.ps1 的
    // renderDone.elapsedMs（≤ 1.5 s）与端到端墙钟耗时验收，本用例不参与预算判定。
    const markdown = hugeDoc().slice(0, 256 * 1024);
    const started = performance.now();
    const out = JJ.renderMarkdown(markdown, { baseUrl: 'https://md.local/' });
    const elapsedMs = performance.now() - started;
    expect(out.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('性能冒烟：前端产物体积', () => {
  it('前端产物体积不超过 640KB', () => {
    const artifact = artifactPath();
    if (!existsSync(artifact)) {
      throw new Error(
        `前端产物不存在：${artifact}；请先在 web/ 下运行 npm run build（或仓库根运行 scripts/build.ps1）。`,
      );
    }
    const { size } = statSync(artifact);
    expect(size).toBeLessThanOrEqual(PRODUCTION_LIMIT_BYTES);
  });
});
