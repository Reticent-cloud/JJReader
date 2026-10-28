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

/** #rrggbb → WCAG 相对亮度（用于正文/代码底对比度断言，避免只锁色值不锁可读性）。 */
function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** 两色 WCAG 对比度（1–21）。 */
function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
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

describe('顶栏/目录栏 chrome 底色与配色维度（palette）', () => {
  const lightCss = readRepoFile('web/src/styles/light.css');
  const darkCss = readRepoFile('web/src/styles/dark.css');
  const baseCss = readRepoFile('web/src/styles/base.css');

  it('顶栏直角、实色 chrome 底、保留底部分隔线（不再是半透明毛玻璃）', () => {
    const toolbarRule = ruleBody(layoutCss, '#toolbar {');
    expect(toolbarRule).toContain('background: var(--chrome-bg);');
    expect(toolbarRule).toContain('border-bottom: 1px solid var(--chrome-border);');
    expect(toolbarRule).not.toContain('backdrop-filter');
    // 顶栏不再读取 --toolbar-bg（保留变量但改指向 chrome 值）
    expect(toolbarRule).not.toContain('--toolbar-bg');
    expect(lightCss).toContain('--toolbar-bg: var(--chrome-bg);');
    expect(darkCss).toContain('--toolbar-bg: var(--chrome-bg);');

    const radiusRule = ruleBody(overridesCss, '#toolbar {');
    expect(radiusRule).toContain('border-radius: 0;');
    expect(overridesCss).not.toContain('border-radius: 0 0 20px 20px');
  });

  it('目录栏用 chrome 底 + 右侧分隔线，正文区用 content 底', () => {
    const tocRule = ruleBody(layoutCss, '\n#toc {');
    expect(tocRule).toContain('background: var(--chrome-bg);');
    expect(tocRule).toContain('border-right: 1px solid var(--chrome-border);');

    const contentRule = ruleBody(layoutCss, '\n#content {');
    expect(contentRule).toContain('background: var(--content-bg);');
  });

  it('工具条按钮 hover/active 在 chrome 底上使用专门的对比色', () => {
    expect(ruleBody(overridesCss, '#toolbar .tool:hover')).toContain('background: var(--chrome-hover-bg);');
    expect(ruleBody(overridesCss, '#toolbar .tool:active')).toContain('background: var(--chrome-active-bg);');
    expect(ruleBody(overridesCss, '#toolbar .tool.active')).toContain('background: var(--chrome-active-bg);');
  });

  it('工具栏常显：不再有 data-toolbar 隐藏规则，固定在顶部且正文预留高度不重复', () => {
    expect(layoutCss).not.toContain('data-toolbar');
    const toolbarRule = ruleBody(layoutCss, '#toolbar {');
    expect(toolbarRule).toContain('position: fixed;');
    expect(toolbarRule).toContain('top: 0;');
    // 正文只有顶部内边距 + scroll-padding-top 两处预留（各一处，避免重复叠加）
    const contentRule = ruleBody(layoutCss, '\n#content {');
    expect(contentRule).toContain('scroll-padding-top: calc(var(--toolbar-height) + 40px);');
    expect((contentRule.match(/padding:\s*calc\(var\(--toolbar-height\)/g) || []).length).toBe(1);
  });

  it('默认中性两主题变量 + 首屏兜底值齐备', () => {
    const lightVars = ruleBody(lightCss, ':root,');
    expect(lightVars).toContain('--chrome-bg: #f3f4f6;');
    expect(lightVars).toContain('--chrome-border: #e2e4e8;');
    expect(lightVars).toContain('--chrome-hover-bg: #eaedf1;');
    expect(lightVars).toContain('--chrome-active-bg: #e0e5ec;');
    expect(lightVars).toContain('--content-bg: #ffffff;');
    expect(lightVars).toContain('--toc-active-bg: #eef0f4;');
    expect(lightVars).toContain('--code-bg: #f6f8fa;');

    const darkVars = ruleBody(darkCss, "html[data-theme='dark']");
    expect(darkVars).toContain('--chrome-bg: #16181d;');
    expect(darkVars).toContain('--chrome-border: #2a2d34;');
    expect(darkVars).toContain('--chrome-hover-bg: #1f222a;');
    expect(darkVars).toContain('--chrome-active-bg: #282c35;');
    expect(darkVars).toContain('--content-bg: #0d0f13;');
    expect(darkVars).toContain('--toc-active-bg: #2b2f3a;');

    const baseVars = ruleBody(baseCss, ':root {');
    expect(baseVars).toContain('--chrome-bg: #f3f4f6;');
    expect(baseVars).toContain('--content-bg: #ffffff;');
  });

  it('鲸鱼蓝是可选项：在 overrides 里覆盖浅色/深色两套 chrome 与正文变量', () => {
    const blueLight = ruleBody(overridesCss, "html[data-palette='blue']:not([data-theme='dark'])");
    expect(blueLight).toContain('--chrome-bg: #e6efff;');
    expect(blueLight).toContain('--chrome-border: #c9d9f7;');
    expect(blueLight).toContain('--chrome-hover-bg: #d9e6ff;');
    expect(blueLight).toContain('--chrome-active-bg: #d4e3ff;');
    expect(blueLight).toContain('--content-bg: #f3f8ff;');
    expect(blueLight).toContain('--toc-active-bg: #d8e6ff;');
    expect(blueLight).toContain('--code-bg: #e8f0fd;');
    expect(blueLight).toContain('--ui-table-head: #e8f0fd;');
    expect(blueLight).toContain('--ui-inline-code: #e8f0fd;');

    const blueDark = ruleBody(overridesCss, "html[data-theme='dark'][data-palette='blue']");
    expect(blueDark).toContain('--chrome-bg: #101a2e;');
    expect(blueDark).toContain('--chrome-border: #22304a;');
    expect(blueDark).toContain('--chrome-hover-bg: #18243c;');
    expect(blueDark).toContain('--chrome-active-bg: #1b2a4a;');
    expect(blueDark).toContain('--content-bg: #0c1424;');
    expect(blueDark).toContain('--toc-active-bg: #1b2a4a;');
  });

  it('正文默认纯白；鲸鱼蓝浅蓝白；代码块可见差异且对比度达标', () => {
    const lightVars = ruleBody(lightCss, ':root,');
    expect(lightVars).toContain('--content-bg: #ffffff;'); // 默认浅色正文纯白
    expect(lightVars).toContain('--code-bg: #f6f8fa;');

    const defaultLight = ruleBody(overridesCss, "html[data-palette='default'] {");
    expect(defaultLight).toContain('--content-bg: #ffffff;');
    const defaultCode = ruleBody(overridesCss, "html[data-palette='default']:not([data-theme='dark'])");
    expect(defaultCode).toContain('--code-bg: #f6f8fa;');
    const blueLight = ruleBody(overridesCss, "html[data-palette='blue']:not([data-theme='dark'])");
    expect(blueLight).toContain('--content-bg: #f3f8ff;'); // 鲸鱼蓝浅色正文浅蓝白
    expect(blueLight).toContain('--code-bg: #e8f0fd;'); // 代码块比正文底更明显一档

    // 首屏预置 data-palette=default，避免默认（白）配色下先闪一帧蓝色。
    expect(indexHtml).toContain('data-palette="default"');

    // WCAG 对比度：正文 ≥ 7:1、次要文字/代码文字 ≥ 4.5:1（默认白底与鲸鱼蓝浅蓝白）。
    expect(contrastRatio('#1f2328', '#ffffff')).toBeGreaterThanOrEqual(7);
    expect(contrastRatio('#1f2328', '#f3f8ff')).toBeGreaterThanOrEqual(7);
    expect(contrastRatio('#59636e', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#59636e', '#f3f8ff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#1f2328', '#e8f0fd')).toBeGreaterThanOrEqual(7);
  });

  it('「默认」中性配色覆盖两套主题，且与 data-theme 正交组合', () => {
    const defaultLight = ruleBody(overridesCss, "html[data-palette='default'] {");
    expect(defaultLight).toContain('--chrome-bg: #f3f4f6;');
    expect(defaultLight).toContain('--chrome-border: #e2e4e8;');
    expect(defaultLight).toContain('--content-bg: #ffffff;');
    expect(defaultLight).toContain('--toc-active-bg: #eef0f4;');

    const defaultDark = ruleBody(overridesCss, "html[data-theme='dark'][data-palette='default']");
    expect(defaultDark).toContain('--chrome-bg: #16181d;');
    expect(defaultDark).toContain('--chrome-border: #2a2d34;');
    expect(defaultDark).toContain('--content-bg: #0d0f13;');

    // 默认配色块在 light.css / dark.css 之后（文件名字母序），能压过主题规则；dark 用双属性提高优先级。
    expect(overridesCss.indexOf("html[data-palette='default'] {")).toBeGreaterThan(-1);
    expect(overridesCss).toContain("html[data-theme='dark'][data-palette='default'] {");
  });

  it('打印 / PDF 不继承 chrome 色：界面 chrome 隐藏、正文纯白', () => {
    expect(printCss).not.toContain('--chrome-');
    expect(printCss).not.toContain('data-palette');
    expect(printCss).toMatch(
      /body\.print-mode #app,\s*body\.print-mode #toc,\s*body\.print-mode #content\s*\{[^}]*background: #ffffff !important;/s,
    );
    expect(printCss).toMatch(/body\.print-mode #content\s*\{[^}]*background: #ffffff;/s);
    expect(printCss).toMatch(/body\.print-mode #toolbar,[\s\S]*display: none !important;/);
  });
});
