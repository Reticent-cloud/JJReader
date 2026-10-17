// 界面美化波评审修复：样式表文本级断言（不渲染、不解析为 CSSOM）。
// 只读取 web/src/styles/*.css 与宿主资源文件，锁定打印/PDF 回落、active 文本用色、front matter reset、
// 两套风格选择器与图标资产；像素级视觉仍按 docs/verify-checklist.md §18 手测。

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 `new URL(relative, import.meta.url)`——Vite 会把这种写法当成资源引用改写（动态模板会被
// 解析成 "undefined"）。这里用 fileURLToPath + path.resolve，测试在 web/ 下执行也能稳定定位仓库根。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function repoPath(relativePath) {
  return resolve(REPO_ROOT, relativePath);
}

function readRepoFile(relativePath) {
  return readFileSync(repoPath(relativePath), 'utf8');
}

function repoFileSize(relativePath) {
  return statSync(repoPath(relativePath)).size;
}

const readerCss = readRepoFile('web/src/styles/overrides-reader.css');
const whaleCss = readRepoFile('web/src/styles/overrides-whale.css');
const printCss = readRepoFile('web/src/styles/print.css');
const layoutCss = readRepoFile('web/src/styles/layout.css');
const indexHtml = readRepoFile('src/Host/Resources/index.html');

/** 取出选择器首次出现处的声明块（测试内只用于本文件里的简单单行选择器）。 */
function ruleBody(css, selector) {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

/** 找出 `@media <header>` 的块范围：返回左花括号到右花括号（含）的 [start, end) 列表。 */
function mediaBlockRanges(css, header) {
  const ranges = [];
  let cursor = 0;
  while ((cursor = css.indexOf(header, cursor)) !== -1) {
    const open = css.indexOf('{', cursor);
    if (open === -1) {
      break;
    }
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') {
        depth += 1;
      } else if (css[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    ranges.push([open, end + 1]);
    cursor = end + 1;
  }
  return ranges;
}

/** 从文本里删掉给定范围（用于确认某规则不在 @media 块之外）。 */
function stripRanges(css, ranges) {
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += css.slice(cursor, start);
    cursor = end;
  }
  return out + css.slice(cursor);
}

const styleCases = [
  ['reader', readerCss, "html[data-ui-style='reader']"],
  ['whale', whaleCss, "html[data-ui-style='whale']"],
];

describe('打印 / PDF 回落（评审 Important 1、Minor 3/4/9）', () => {
  it('链接回到正文色 + 下划线', () => {
    expect(printCss).toContain('body.print-mode #content a');
    // 双保险选择器：特异性高于界面风格的 html[data-ui-style] #content a。
    expect(printCss).toContain('html[data-ui-style] body.print-mode #content a');
    expect(printCss).toMatch(
      /body\.print-mode #content a[^{]*\{[^}]*color: inherit;[^}]*text-decoration: underline;/s,
    );
  });

  it('鲸尾列表符号隐藏并恢复普通列表符号（任务清单仍无符号）', () => {
    expect(printCss).toContain('body.print-mode #content ul');
    expect(printCss).toMatch(/body\.print-mode #content ul[^{]*\{[^}]*list-style: revert;/s);
    expect(printCss).toMatch(
      /body\.print-mode #content ul[^{]*li::before[^{]*\{[^}]*content: none !important;[^}]*display: none !important;/s,
    );
    expect(printCss).toMatch(
      /body\.print-mode #content ul\.contains-task-list\s*\{[^}]*list-style: none;/s,
    );
  });

  it('h1 的强调线 / 下边框不进入纸面', () => {
    expect(printCss).toContain('body.print-mode #content h1');
    expect(printCss).toMatch(
      /body\.print-mode #content h1\s*\{[^}]*border-bottom: 0 !important;[^}]*background: none !important;/s,
    );
  });

  it('front matter 表格在纸面不继承界面风格的边框/底色', () => {
    const cellRule = ruleBody(printCss, 'body.print-mode #content .frontmatter th');
    expect(cellRule).toContain('border: 0 !important;');
    expect(cellRule).toContain('background: transparent !important;');
  });

  it('通知条（#notice-stack）不进入纸面', () => {
    expect(printCss).toMatch(/body\.print-mode #notice-stack[^{]*\{[^}]*display: none !important;/s);
  });
});

describe('通知条不覆盖正文/TOC（修复波 E）', () => {
  it('#notice-stack 是内容列上方的网格行，不再 fixed 覆盖', () => {
    const body = ruleBody(layoutCss, '#notice-stack');
    expect(body).toContain('grid-column: 2;');
    expect(body).toContain('grid-row: 1;');
    expect(body).not.toMatch(/position:\s*fixed/);
    expect(body).toContain('pointer-events: none;');
  });

  it('#content 位于通知行下方，#toc 跨两行不被挤占', () => {
    expect(ruleBody(layoutCss, '\n#content {')).toContain('grid-row: 2;');
    expect(ruleBody(layoutCss, '\n#toc {')).toContain('grid-row: 1 / -1;');
  });

  it('无通知时整行不占高度（hidden 压过 display: flex）', () => {
    expect(layoutCss).toMatch(/#notice-stack\[hidden\]\s*\{[^}]*display: none;/s);
  });
});

describe('界面风格的屏幕链接规则（评审 Important 1）', () => {
  it.each(styleCases)('%s：正文链接规则全部在 @media screen 内', (_name, css) => {
    const ranges = mediaBlockRanges(css, '@media screen');
    expect(ranges.length).toBeGreaterThan(0);
    const screenText = ranges.map(([start, end]) => css.slice(start, end)).join('\n');
    expect(screenText).toContain('#content a');
    expect(stripRanges(css, ranges)).not.toContain('#content a');
  });
});

describe('active 文本对比度（评审 Important 2）', () => {
  it.each(styleCases)('%s：active 文本使用 --ui-accent-strong，强调色只用于条/边框', (_name, css) => {
    for (const selector of ['#toolbar .tool.active', '#toc nav.toc a.active']) {
      expect(ruleBody(css, selector)).toMatch(/color: var\(--ui-accent-strong\);/);
    }
    // --ui-accent 仍用于背景/边框/轮廓/图标，但不再作为文本 color（避免浅色 active 底上 < 4.5:1）。
    expect(css).not.toMatch(/^\s*color:\s*var\(--ui-accent\);/m);
  });

  it('whale 的 TOC hover 文本同样使用 --ui-accent-strong', () => {
    expect(ruleBody(whaleCss, '#toc nav.toc a:hover')).toMatch(/color: var\(--ui-accent-strong\);/);
  });
});

describe('front matter 表格 reset（评审 Minor 4）', () => {
  it.each(styleCases)('%s：属性表清掉通用表格外框/表头底/斑马纹', (_name, css) => {
    const tableRule = ruleBody(css, '#content .frontmatter table');
    expect(tableRule).toContain('border: 0;');
    expect(tableRule).toContain('border-radius: 0;');

    const cellRule = ruleBody(css, '#content .frontmatter th');
    expect(cellRule).toContain('border: 0;');
    expect(cellRule).toContain('background: transparent;');

    const zebraRule = ruleBody(css, '#content .frontmatter tbody tr:nth-child(even) > td');
    expect(zebraRule).toContain('background: transparent;');
  });
});

describe('风格文件与首屏/图标资产', () => {
  it.each(styleCases)('%s：风格文件存在且包含对应 [data-ui-style] 选择器', (_name, css, selector) => {
    expect(css.length).toBeGreaterThan(1000);
    expect(css).toContain(selector);
  });

  it('删除了未使用的 --whale-ink 令牌', () => {
    expect(whaleCss).not.toContain('--whale-ink');
  });

  it('index.html 首屏默认 reader（无本地存储策略下的已知取舍）', () => {
    expect(indexHtml).toContain('data-ui-style="reader"');
  });

  it('原创鲸鱼女仆娘图标存在且大小合理（> 5 KB，不解析 ICO）', () => {
    expect(repoFileSize('src/Host/app.ico')).toBeGreaterThan(5 * 1024);
  });
});
