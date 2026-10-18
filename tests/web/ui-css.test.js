// 单一界面风格与打印回落的样式表文本级断言（不渲染、不解析为 CSSOM）。
// 只读取 web/src/styles/*.css、复制按钮脚本与宿主资源文件，锁定打印/PDF 回落、active 文本用色、
// front matter reset、通知条布局、复制按钮短暂闪烁与图标资产；像素级视觉仍按 docs/verify-checklist.md 手测。

import { existsSync, readFileSync, statSync } from 'node:fs';
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

const overridesCss = readRepoFile('web/src/styles/overrides.css');
const printCss = readRepoFile('web/src/styles/print.css');
const codeCss = readRepoFile('web/src/styles/code.css');
const layoutCss = readRepoFile('web/src/styles/layout.css');
const indexHtml = readRepoFile('src/Host/Resources/index.html');
const enhanceJs = readRepoFile('web/src/enhance.js');

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

describe('whale 主题已彻底删除', () => {
  it('不再有 whale 样式表 / 界面风格脚本 / 对应测试', () => {
    expect(existsSync(repoPath('web/src/styles/overrides-whale.css'))).toBe(false);
    expect(existsSync(repoPath('web/src/ui-style.js'))).toBe(false);
    expect(existsSync(repoPath('tests/web/ui-style.test.js'))).toBe(false);
    expect(existsSync(repoPath('web/src/mascot.js'))).toBe(false);
  });

  it('样式与首屏不再引用 data-ui-style', () => {
    for (const css of [overridesCss, printCss, codeCss]) {
      expect(css).not.toContain('data-ui-style');
    }
    expect(indexHtml).not.toContain('data-ui-style');
  });

  it('单一风格文件存在且使用全局选择器（不再有 whale 令牌/选择器）', () => {
    expect(overridesCss.length).toBeGreaterThan(1000);
    expect(overridesCss).not.toMatch(/--whale-/);
    expect(overridesCss).not.toContain("[data-ui-style='whale']");
    expect(overridesCss).toContain(':root {');
    expect(overridesCss).toContain("html[data-theme='dark'] {");
  });
});

describe('打印 / PDF 回落（评审 Important 1、Minor 3/4/9）', () => {
  it('链接回到正文色 + 下划线', () => {
    expect(printCss).toContain('body.print-mode #content a');
    expect(printCss).toMatch(
      /body\.print-mode #content a[^{]*\{[^}]*color: inherit;[^}]*text-decoration: underline;/s,
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

describe('正文链接的屏幕规则（评审 Important 1）', () => {
  it('全部在 @media screen 内，打印/PDF 不受蓝色无下划线影响', () => {
    const ranges = mediaBlockRanges(overridesCss, '@media screen');
    expect(ranges.length).toBeGreaterThan(0);
    const screenText = ranges.map(([start, end]) => overridesCss.slice(start, end)).join('\n');
    expect(screenText).toContain('#content a');
    expect(screenText).toContain('text-decoration: none;');
    expect(stripRanges(overridesCss, ranges)).not.toContain('#content a');
  });
});

describe('active 文本对比度（评审 Important 2）', () => {
  it('active 文本使用 --ui-accent-strong，强调色只用于条/边框', () => {
    for (const selector of ['#toolbar .tool.active', '#toc nav.toc a.active']) {
      expect(ruleBody(overridesCss, selector)).toMatch(/color: var\(--ui-accent-strong\);/);
    }
    // --ui-accent 仍用于背景/边框/轮廓/图标，但不再作为文本 color（避免浅色 active 底上 < 4.5:1）。
    expect(overridesCss).not.toMatch(/^\s*color:\s*var\(--ui-accent\);/m);
  });
});

describe('front matter 表格 reset（评审 Minor 4）', () => {
  it('属性表清掉通用表格外框/表头底/斑马纹', () => {
    const tableRule = ruleBody(overridesCss, '#content .frontmatter table');
    expect(tableRule).toContain('border: 0;');
    expect(tableRule).toContain('border-radius: 0;');

    const cellRule = ruleBody(overridesCss, '#content .frontmatter th');
    expect(cellRule).toContain('border: 0;');
    expect(cellRule).toContain('background: transparent;');

    const zebraRule = ruleBody(overridesCss, '#content .frontmatter tbody tr:nth-child(even) > td');
    expect(zebraRule).toContain('background: transparent;');
  });
});

describe('复制按钮：短暂闪烁而不是常驻高亮', () => {
  it('成功后只保留 data-copied 260ms（脚本常量 + 清除属性）', () => {
    expect(enhanceJs).toContain('COPY_FEEDBACK_MS = 260');
    expect(enhanceJs).toMatch(/clearTimeout\(pending\)/);
    expect(enhanceJs).toMatch(/delete btn\.dataset\.copied/);
    expect(enhanceJs).toMatch(/delete btn\.dataset\.failed/);
  });

  it('成功/失败都派发 jj:copy{ok} 供 shell 弹 toast', () => {
    expect(enhanceJs).toContain("new globalThis.CustomEvent('jj:copy', { detail: { ok } })");
  });

  it('闪烁样式只挂在 data-copied / data-failed 上并有短颜色过渡', () => {
    expect(codeCss).toContain(".code-wrap .copy[data-copied='1']");
    expect(codeCss).toContain(".code-wrap .copy[data-failed='1']");
    expect(codeCss).toMatch(
      /\.code-wrap \.copy\[data-copied='1'\]\s*\{[^}]*color: var\(--accent\);[^}]*border-color: var\(--accent\);/s,
    );
    expect(codeCss).toMatch(/transition:[^;]*color 0\.12s ease;/s);
    expect(codeCss).toMatch(/transition:[^;]*border-color 0\.12s ease;/s);
  });
});

describe('图标与插画资产保留', () => {
  it('app.ico 与 AboutMascot.png 仍存在且大小合理（不解析 ICO/PNG）', () => {
    expect(repoFileSize('src/Host/app.ico')).toBeGreaterThan(5 * 1024);
    expect(repoFileSize('src/Host/AboutMascot.png')).toBeGreaterThan(10 * 1024);
    expect(repoFileSize('assets/mascot-source.jpg')).toBeGreaterThan(100 * 1024);
  });

  it('空状态插画 data URI 模块仍被 recent.js 使用', () => {
    expect(existsSync(repoPath('web/src/mascot-photo.js'))).toBe(true);
    expect(readRepoFile('web/src/shell/recent.js')).toContain('MASCOT_PHOTO');
  });
});

describe('正文居中、toast 对齐与进度条移除', () => {
  it('#content 用对称 padding 居中（标题 margin 不再导致最大化后贴左）', () => {
    const layoutCss = readRepoFile('web/src/styles/layout.css');
    expect(layoutCss).toMatch(
      /padding:\s*calc\(var\(--toolbar-height\) \+ 16px\)\s+max\(28px,\s*calc\(\(100% - var\(--content-width\)\) \/ 2\)\)\s+96px;/s,
    );
  });

  it('#toast 在正文列内居中，目录折叠时回窗口居中', () => {
    const layoutCss = readRepoFile('web/src/styles/layout.css');
    expect(layoutCss).toMatch(/#toast\s*\{[^}]*left:\s*calc\(50% \+ var\(--toc-width, 0px\) \/ 2\);/s);
    expect(layoutCss).toMatch(/#app\[data-toc='hidden'\] #toast\s*\{[^}]*left:\s*50%;/s);
  });

  it('右侧竖向进度条已移除：无 #progress / #progress-bar CSS，chrome 不再创建', () => {
    const layoutCss = readRepoFile('web/src/styles/layout.css');
    expect(layoutCss).not.toContain('#progress');
    const chromeSrc = readRepoFile('web/src/shell/chrome.js');
    expect(chromeSrc).not.toContain("'progress'");
    expect(chromeSrc).not.toContain('#progress-bar');
    expect(chromeSrc).toContain('backToTopEl');
    expect(readRepoFile('web/src/styles/print.css')).not.toContain('#progress');
  });
});

describe('圆角化（v3）', () => {
  it('统一大圆角与胶囊按钮，滚动条细窄圆角', () => {
    const css = readRepoFile('web/src/styles/overrides.css');
    expect(css).toMatch(/:root\s*\{[^}]*--radius:\s*12px;/s);
    expect(css).toMatch(/#toolbar \.tool[^{]*\{[^}]*border-radius:\s*999px;/s);
    expect(css).toMatch(/#recent-menu,\s*\.aa-panel\s*\{[^}]*border-radius:\s*22px;/s);
    expect(css).toMatch(/#content pre,\s*#content \.code-wrap pre\s*\{[^}]*border-radius:\s*16px;/s);
    expect(css).toMatch(/#content::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*999px;/s);
  });
});

describe('回到顶部图标按钮（v4）', () => {
  it('按钮是 40×40 圆形、无文案字号，图标跟随前景色', () => {
    const css = readRepoFile('web/src/styles/layout.css');
    expect(css).toMatch(/#back-to-top\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*padding:\s*0;/s);
    expect(css).not.toMatch(/#back-to-top\s*\{[^}]*font-size:/s);
    expect(css).toMatch(/#back-to-top \.back-to-top-icon\s*\{[^}]*display:\s*block;/s);
  });
});

describe('横向滚动条与目录高亮（v5）', () => {
  it('正文列与页面不出现横向滚动条（代码块内部保留横向滚动）', () => {
    const layoutCss = readRepoFile('web/src/styles/layout.css');
    expect(layoutCss).toMatch(/#content\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(layoutCss).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(layoutCss).toMatch(/\.code-wrap pre\s*\{[^}]*overflow-x:\s*auto;/s);
  });

  it('目录当前项只有胶囊底色，没有左侧深蓝强调条', () => {
    const css = readRepoFile('web/src/styles/overrides.css');
    expect(css).not.toContain('a.active::before');
    expect(css).toMatch(/#toc nav\.toc a\.active\s*\{[^}]*background:\s*var\(--toc-active-bg\);/s);
  });
});
