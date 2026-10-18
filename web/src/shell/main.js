// shell 总装：固定 DOM 骨架、消息分发、正文渲染与 renderDone 回报。
// 正文走 JJ.renderMarkdown（Task 5 起为 markdown-it 引擎），引擎缺失时降级 escapeHtml + <pre> 保证不白屏。
// Task 10 起装配阅读体验：TOC 侧栏（标题 id 兜底 + 滚动联动 + 拖拽调宽）、主题三态、排版面板（Aa）与快捷键。
// Task 12 起装配最近文件、位置记忆、阅读进度条/回到顶部、悬浮工具条与 F5/Alt+←→/Ctrl+Shift+C。
// Task 13 起加打开入口（Ctrl+O/Ctrl+Shift+O、工具条按钮）与 wikilink/附件点击寻文件（openFile 消息）。
// 模块拆分（T10 评审 carry-forward）：工具条与 Aa 面板 → toolbar.js；最近文件面板 → recent.js；
// 位置追踪/进度条/回到顶部/toast → chrome.js；标题 id + TOC/滚动联动 → headings.js；正文渲染管线 → render.js；
// Task 14 评审拆分：文件夹浏览（浏览根、dirListing 应用、树/大纲切换、树内打开与高亮）→ browse.js，这里只留装配。
// 设计约束：所有设置变更「先应用再上报」——applySettings/applyTheme 同步写 CSS 变量，随后 post('saveSettings', {patch})，
// 只发变化字段（宿主合并后落盘）；任何一步失败都不能影响正文渲染。

import { utf8Length } from '../chunk.js';
import {
  applySettings,
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeTocWidth,
  settingsPatch,
  TOC_WIDTH_DEFAULT,
  TOC_WIDTH_MAX,
  TOC_WIDTH_MIN,
} from '../settings.js';
import { applyTheme, nextTheme } from '../theme.js';
import { buildToc } from '../toc.js';
import { applyUiStyle, nextUiStyle, uiStyleLabel } from '../ui-style.js';
import { bubbleDecor } from '../mascot.js';
import { MASCOT_PHOTO } from '../mascot-photo.js';
import { createBrowser } from './browse.js';
import {
  clearToastContainer,
  createChromeElements,
  createPositionTracker,
  estimateTotalHeight,
  setToastContainer,
  showToast,
  updateChrome,
} from './chrome.js';
import { createTocController } from './headings.js';
import { pdfSuggestedFileName } from '../print.js';
import { nextRecentPath, normalizeRecentItems, renderRecent } from './recent.js';
import { createRenderer } from './render.js';
import { createTocResizer } from './resizer.js';
import { createSettingsSaver } from './settings-saver.js';
import { buildAaPanel, createToolbar, themeLabel } from './toolbar.js';

/** 工具条悬浮显示：鼠标进入窗口顶部 40px 区域（spec §5.1）。 */
const TOOLBAR_HOVER_ZONE_PX = 40;

/** 工具条自动隐藏延迟（spec §5.1：移出 800ms 后隐藏）。 */
const TOOLBAR_HIDE_DELAY_MS = 800;

/** 全局唯一的时间源：优先高精度计时，缺失时退回 Date.now。 */
function now() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/** 目标元素是否是可编辑控件（输入框/下拉/可编辑区）：这些控件内的快捷键交还给控件本身。 */
function isEditableTarget(target) {
  if (!target || target.nodeType !== 1) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null;
}

/**
 * 在 root（宿主页面的 #app）里装配 shell，返回 { root, onMessage, destroy }。
 * post(type, payload) 由调用方注入：浏览器环境走 window.chrome.webview.postMessage，
 * 测试传收集器。mountShell 完成后立即发一次 shellReady（宿主收到后才推送 load，
 * 避免 PostWebMessageAsJson 在页面监听器就绪前丢失）。
 */
export function mountShell({ root, post } = {}) {
  if (!root) {
    throw new Error('mountShell: 缺少 root 容器');
  }
  const send = typeof post === 'function' ? post : () => {};

  // Task 15：打印模式需要从 JJ.enterPrintModeForPdf 回报 readyToPrint（宿主 --verify-pdf 依赖它）。
  // 不覆盖其他模块注入的成员，只记 post；destroy 时若仍指向本次装配则清掉，避免闭包残留。
  if (globalThis.JJ && typeof globalThis.JJ === 'object') {
    globalThis.JJ.__post = send;
  }

  // 固定骨架：#app > header#toolbar、aside#toc、div.toc-resizer（拖拽调宽分隔条）、main#content（滚动容器）、
  // div#progress（阅读进度条）、button#back-to-top、div#aa-panel、div#recent-menu（工具条最近菜单）、div#toast。
  // 分隔条绝对定位在侧栏右缘（不占网格列），折叠时隐藏；进度条/回到顶部/工具条都是 fixed 悬浮层。
  root.replaceChildren();
  const toolbarParts = createToolbar();
  const toolbar = toolbarParts.element;
  const {
    openFile: openFileButton,
    openFolder: openFolderButton,
    browseRoot: browseRootButton,
    treeBack: treeBackButton,
    tocToggle,
    recentToggle,
    exportPdf: exportPdfButton,
    themeToggle,
    uiStyleToggle,
    aaToggle,
    about: aboutButton,
  } = toolbarParts;
  const toc = document.createElement('aside');
  toc.id = 'toc';
  toc.setAttribute('aria-label', '大纲');
  toc.dataset.sidebar = 'toc';
  // Task 14：侧栏内容分两块——大纲（tocNav，交给 headings 控制器替换）与文件树（fileTree）。
  // 树容器必须是 aside 的直接子元素：headings 的 renderToc 只会 replaceChildren(tocNav)，不会冲掉文件树。
  const tocNav = document.createElement('div');
  tocNav.id = 'toc-nav';
  const fileTree = document.createElement('div');
  fileTree.id = 'file-tree';
  fileTree.className = 'file-tree-panel';
  fileTree.hidden = true;
  const treeEmptyHint = document.createElement('p');
  treeEmptyHint.className = 'tree-empty';
  treeEmptyHint.textContent = '尚未打开文件夹';
  fileTree.append(treeEmptyHint);
  toc.append(tocNav, fileTree);
  const tocResizer = document.createElement('div');
  tocResizer.className = 'toc-resizer';
  tocResizer.setAttribute('role', 'separator');
  tocResizer.setAttribute('aria-orientation', 'vertical');
  tocResizer.setAttribute('aria-label', '调整大纲宽度');
  tocResizer.setAttribute('aria-valuemin', String(TOC_WIDTH_MIN));
  tocResizer.setAttribute('aria-valuemax', String(TOC_WIDTH_MAX));
  tocResizer.setAttribute('aria-valuenow', String(TOC_WIDTH_DEFAULT));
  tocResizer.tabIndex = 0;
  tocResizer.title = '拖动调整大纲宽度，双击重置为 240';
  const content = document.createElement('main');
  content.id = 'content';
  const aaPanel = buildAaPanel();
  const recentMenu = document.createElement('div');
  recentMenu.id = 'recent-menu';
  recentMenu.className = 'recent-menu';
  recentMenu.hidden = true;
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.hidden = true;

  // 修复波 B-§5.11 / 波 E：内容顶部通知栈（错误条 + 大文件横幅）。
  // 作为 #app 内容列第一行的网格项：有通知时挤占高度、不覆盖正文/TOC；无通知时 hidden（整行 0 高）。
  // 可关闭、持久显示（role=alert 在 errorBar 上，暗色由 light/dark 变量适配）。
  const noticeStack = document.createElement('div');
  noticeStack.id = 'notice-stack';
  noticeStack.hidden = true;
  const errorBar = document.createElement('div');
  errorBar.id = 'error-bar';
  errorBar.hidden = true;
  errorBar.setAttribute('role', 'alert');
  const errorBarText = document.createElement('span');
  errorBarText.className = 'notice-text';
  const errorBarClose = document.createElement('button');
  errorBarClose.type = 'button';
  errorBarClose.className = 'notice-close';
  errorBarClose.textContent = '关闭';
  errorBarClose.setAttribute('aria-label', '关闭错误提示');
  errorBar.append(errorBarText, errorBarClose);

  const hugeBanner = document.createElement('div');
  hugeBanner.id = 'huge-banner';
  hugeBanner.hidden = true;
  hugeBanner.setAttribute('role', 'status');
  const hugeBannerText = document.createElement('span');
  hugeBannerText.className = 'notice-text';
  hugeBannerText.textContent = '大文件模式：已关闭代码高亮';
  const hugeBannerClose = document.createElement('button');
  hugeBannerClose.type = 'button';
  hugeBannerClose.className = 'notice-close';
  hugeBannerClose.textContent = '关闭';
  hugeBannerClose.setAttribute('aria-label', '关闭大文件模式提示');
  hugeBanner.append(hugeBannerText, hugeBannerClose);
  noticeStack.append(errorBar, hugeBanner);

  // 界面美化波 v2：固定气泡/水印装饰层。只有 whale 风格由 CSS 显示（reader 下 display:none）。
  // 内容全部来自 mascot.js 常量 SVG、mascot-photo.js 的常量 data URI 与数字样式（不含用户输入）；
  // aria-hidden + pointer-events:none，不参与正文布局与文本选择，也不拦截点击。
  const uiDecor = document.createElement('div');
  uiDecor.id = 'ui-decor';
  uiDecor.setAttribute('aria-hidden', 'true');
  uiDecor.innerHTML = `${bubbleDecor(14)}<div class="ui-watermark" aria-hidden="true"><img src="${MASCOT_PHOTO}" alt="" decoding="async"></div>`;

  const { progress, progressEl, backToTopEl } = createChromeElements();
  root.append(
    toolbar,
    toc,
    tocResizer,
    content,
    progress,
    backToTopEl,
    aaPanel,
    recentMenu,
    toast,
    noticeStack,
    uiDecor,
  );
  setToastContainer(toast);
  // 悬浮工具条默认隐藏：鼠标进顶部 40px 或按 Alt 才显示（隐藏时键盘快捷键照常可用）。
  root.dataset.toolbar = 'hidden';

  /** 通知条容器随内容显隐：两条都隐藏时整行高度为 0（不再用 fixed 覆盖正文/TOC 顶部）。 */
  function syncNoticeStack() {
    noticeStack.hidden = errorBar.hidden && hugeBanner.hidden;
  }

  /**
   * 显示持久错误条（spec §5.11：文件打不开/编码异常/渲染异常）。可关闭；不自动消失。
   * @param {string} text
   * @param {{level?: 'error'|'warn'|'info'}} [options]
   */
  function showErrorBar(text, { level = 'error' } = {}) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value === '') {
      return;
    }
    errorBarText.textContent = value;
    errorBar.dataset.level = level;
    errorBar.hidden = false;
    syncNoticeStack();
  }

  function hideErrorBar() {
    errorBar.hidden = true;
    syncNoticeStack();
  }

  function showHugeBanner() {
    hugeBanner.hidden = false;
    syncNoticeStack();
  }

  function hideHugeBanner() {
    hugeBanner.hidden = true;
    syncNoticeStack();
  }

  // TOC/标题 id 控制器：持有标题快照、滚动联动 spy 与 TOC 高亮（实现见 headings.js）。
  // Task 14：只接管 #toc-nav（文件树容器是 aside 的另一个子元素，不能被 TOC 渲染替换）。
  const tocController = createTocController({ content, toc: tocNav });

  const state = {
    path: '',
    key: '',
    baseUrl: '',
    settings: normalizeSettings(DEFAULT_SETTINGS),
    position: null,
    // Task 16：宿主下发的 .md 关联状态 { registered, isDefault }（关于按钮 title 用）
    assocState: null,
    // 修复波 B-§5.11：load 附带的编码名（utf-8 / gb18030 / binary …，仅调试用）
    encoding: 'utf-8',
    dirListing: null,
    // Task 12：是否收到过 load（空白启动页显示最近文件面板）、最近文件列表（Alt+←/→ 切换用）
    loaded: false,
    recent: [],
    // Task 11：大文件模式标记（关闭高亮、停用滚动联动）、分块渲染器句柄
    huge: false,
    chunked: null,
    // 分块字节统计（由 render.js 写入）：{totalBytes, totalBlocks, renderedBlocks, renderedBytes}
    // 位置追踪在未全部渲染时按它估算全文高度（T12 评审 Important 1）
    chunkBytes: null,
    // Task 12：位置追踪器（每次 load 重建；节流上报 savePosition）
    positionTracker: null,
  };

  // 文件夹浏览控制器（Task 14 评审拆分）：浏览根、dirListing 应用与校验、树/大纲模式切换、
  // 树内打开与高亮都在 browse.js；getDocumentPath 让 dirListing 到达时按当前文档同步高亮。
  const browser = createBrowser({
    browseRootButton,
    treeBackButton,
    post: send,
    getDocumentPath: () => state.path,
  });

  // 正文渲染管线（兜底/分块/front matter/增强，实现见 render.js）；它读写 state.huge / state.chunked。
  const renderer = createRenderer({
    content,
    getState: () => state,
    tocController,
    send,
    showToast,
    showErrorBar,
    showHugeBanner,
    hideHugeBanner,
  });

  // Task 15 修复：PDF 导出前由 print.js 调用，把分块懒渲染的剩余块同步渲染出来再进打印模式。
  // 无分块/已全渲染时同步返回 false（空操作）；destroy 时若仍指向本次装配则清掉，避免旧闭包残留。
  function ensureAllRendered() {
    return renderer.ensureAllRendered();
  }
  if (globalThis.JJ && typeof globalThis.JJ === 'object') {
    globalThis.JJ.__ensureAllRendered = ensureAllRendered;
  }

  // 标题 top 快照只在渲染时采集一次，以下场景会重排而失效：字号/行距/行宽变化（Aa 面板/快捷键）、
  // TOC 侧栏拖宽、图片异步加载或占位替换、窗口尺寸变化。重排后重新采集交给 spy，点击定位另外实时读元素（双保险）。
  /** 把刷新合并到下一帧（标题位置重采集见 headings.js 的 scheduleRefresh）。 */
  function scheduleRefreshHeadingTops() {
    tocController.scheduleRefresh();
  }

  /** 主题：写 data-theme（system 跟随系统）并同步按钮文案。 */
  function applyThemeState() {
    const resolved = applyTheme(state.settings.theme);
    const label = themeLabel(state.settings.theme);
    themeToggle.textContent = label;
    themeToggle.setAttribute('aria-label', `主题：${label}（点击切换）`);
    themeToggle.title = `主题：${label}（点击循环：浅色 → 深色 → 跟随系统）`;
    return resolved;
  }

  /**
   * 界面风格（界面美化波）：写 html[data-ui-style]（applySettings 也会写，这里再同步按钮文案/状态）。
   * 只改视觉，不改变布局结构与交互；未知值由 applyUiStyle 回退 reader。
   */
  function applyUiStyleState() {
    const style = applyUiStyle(state.settings.uiStyle);
    const label = uiStyleLabel(style);
    const nextLabel = style === 'whale' ? '阅读器风' : '鲸鱼娘主题';
    uiStyleToggle.title = `界面风格：${label}（点击切换为${nextLabel}）`;
    uiStyleToggle.setAttribute('aria-label', `界面风格：${label}（点击切换）`);
    uiStyleToggle.setAttribute('aria-pressed', String(style === 'whale'));
    return style;
  }

  /** 侧栏显隐：CSS 用 #app[data-toc="hidden"] 折叠（保持 DOM，切回不重建 TOC）；折叠时分隔条同步隐藏。 */
  function applyTocVisibility() {
    const visible = state.settings.tocVisible;
    root.setAttribute('data-toc', visible ? 'visible' : 'hidden');
    tocToggle.setAttribute('aria-pressed', String(visible));
    tocToggle.classList.toggle('active', visible);
    tocResizer.hidden = !visible;
  }

  /** Aa 面板控件回显当前设置（快捷键改字号后滑杆同步；滑杆的 aria-valuenow 一起同步）。 */
  function syncAaControls() {
    for (const control of aaPanel.querySelectorAll('[data-setting]')) {
      const key = control.dataset.setting;
      const value = state.settings[key];
      if (value === undefined) {
        continue;
      }
      control.value = String(value);
      if (control.getAttribute('type') === 'range') {
        // T12 评审 Minor e：滑杆的无障碍当前值随数值更新（快捷键/拖动两条路径都会经过这里）
        control.setAttribute('aria-valuenow', String(value));
      }
      const output = control.parentElement ? control.parentElement.querySelector('.aa-value') : null;
      if (output) {
        output.textContent = String(value);
      }
    }
  }

  /** 分隔条无障碍状态回显（tocWidth 数值 → aria-valuenow，读屏可感知当前宽度）。 */
  function syncTocResizerWidth() {
    tocResizer.setAttribute('aria-valuenow', String(state.settings.tocWidth));
  }

  /** 面板控件值 → 设置字段类型（滑杆给字符串，设置比较要数值）。 */
  function coerceSettingValue(key, raw) {
    if (key === 'fontSize') {
      return Math.round(Number(raw));
    }
    if (key === 'lineHeight' || key === 'contentWidth') {
      return Number(raw);
    }
    return String(raw);
  }

  // ── 设置落盘防抖（T12 评审 Minor b：拖动期间只 apply，停手 300ms 才 post('saveSettings')） ──
  // 累积/合并/定时器逻辑在 settings-saver.js；这里只负责把 apply 后的 patch 交给它。
  const settingsSaver = createSettingsSaver({ send });

  /** 立即发出防抖中累积的设置 patch（关面板/离开面板/destroy 调用）。 */
  function flushSettingsSave() {
    settingsSaver.flush();
  }

  /**
   * 唯一设置入口：归一 → 只算变化字段 → 先应用（写 CSS 变量/主题/侧栏）→ 再上报 saveSettings{patch}。
   * 没有变化时什么都不做（不重复发消息）。
   * @param {object} next 部分设置字段
   * @param {{deferSave?: boolean}} [options] deferSave：滑杆拖动中只 apply，落盘走 300ms 防抖
   * @returns {object} 实际发送的 patch（无变化为空对象）
   */
  function updateSettings(next, { deferSave = false } = {}) {
    const merged = normalizeSettings({ ...state.settings, ...(next && typeof next === 'object' ? next : {}) });
    const patch = settingsPatch(state.settings, merged);
    if (Object.keys(patch).length === 0) {
      return {};
    }
    state.settings = merged;
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      applyThemeState();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'uiStyle')) {
      applyUiStyleState();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'tocVisible')) {
      applyTocVisibility();
    }
    applySettings(state.settings);
    syncAaControls();
    // 字号/行距/行宽（以及侧栏宽度）变化都会重排正文：刷新标题位置快照
    scheduleRefreshHeadingTops();
    // 非拖动路径会把累积的滑杆 patch 合并进本次消息一起发（不留 pending 里的旧值覆盖新值）
    settingsSaver.save(patch, { defer: deferSave });
    return patch;
  }

  /**
   * 拖拽中的实时预览：更新 tocWidth 状态 + 写 --toc-width（applySettings），不落盘。
   * 拖动期间逐帧 saveSettings 会刷屏，因此松手时由 commitTocWidth 统一上报一次。
   */
  function previewTocWidth(width) {
    state.settings = normalizeSettings({ ...state.settings, tocWidth: width });
    applySettings(state.settings);
    syncTocResizerWidth();
    // 拖拽预览与松手（commit 复用 preview）都会改变正文列宽：合并到下一帧刷新标题位置
    scheduleRefreshHeadingTops();
  }

  /**
   * 拖拽/双击/方向键结束：以「起始宽」为基准算 patch，只上报变化的 tocWidth（与 updateSettings 的 settingsPatch 口径一致）。
   * 起始宽由 resizer 模块保存并回传（拖拽中 state.settings 已被预览更新，不能拿它当基准）。
   * @returns {object} 实际发送的 patch（无变化为空对象）
   */
  function commitTocWidth(width, startWidth) {
    const base = { ...state.settings, tocWidth: normalizeTocWidth(startWidth) };
    previewTocWidth(width);
    const patch = settingsPatch(base, { tocWidth: state.settings.tocWidth });
    if (Object.keys(patch).length > 0) {
      send('saveSettings', { patch });
    }
    return patch;
  }

  // 分隔条交互（指针拖拽 / 双击重置 240 / 方向键 ±10）：本模块只管指针状态机，宽度合法性与持久化走上面的回调。
  const tocResizerControl = createTocResizer({
    handle: tocResizer,
    getWidth: () => state.settings.tocWidth,
    onPreview: previewTocWidth,
    onCommit: commitTocWidth,
    defaultWidth: TOC_WIDTH_DEFAULT,
  });

  /**
   * 分块渲染模式下 TOC 点击/内联目录点击的定位参数：
   * 目标块未渲染（或大文件模式）时先 renderAll，再由 headings 控制器刷新快照并重试定位。
   */
  function chunkRenderOptions() {
    return {
      shouldRenderAll: (element) => Boolean(state.chunked) && (state.huge || !element),
      renderAll: () => {
        if (state.chunked) {
          state.chunked.renderAll();
        }
      },
    };
  }

  /** 侧栏 TOC 点击：阻止默认跳转，复用 headings 控制器的 scrollToHeading。 */
  function onTocClick(event) {
    tocController.handleTocClick(event, chunkRenderOptions());
  }

  /**
   * 正文点击委托：
   * - `[TOC]` 内联目录（评审 #1）：只接管 nav.toc-inline 内的锚点链接，脚注回跳等保持默认行为；
   * - wikilink / 非图片附件（Task 13）：`.wikilink[data-target]` 与 `a.attachment[data-target]` 阻止默认跳转，
   *   把 data-target 原样作为 openFile 的 relPath 发给宿主（目标不可信，只进消息字段，由宿主按文档目录解析）；
   *   图片形式的 .attachment 是 img 且没有 data-target，不拦截。
   */
  function onContentClick(event) {
    const target = event && event.target;
    if (target && typeof target.closest === 'function') {
      const link = target.closest('.wikilink[data-target], a.attachment[data-target]');
      if (link) {
        event.preventDefault();
        const relPath = link.getAttribute('data-target');
        if (typeof relPath === 'string' && relPath !== '') {
          send('openFile', { relPath });
        }
        return;
      }
    }
    tocController.handleInlineTocClick(event, chunkRenderOptions());
  }

  function openAaPanel() {
    aaPanel.hidden = false;
    aaToggle.setAttribute('aria-expanded', 'true');
  }

  /** 关闭面板：滑杆防抖中的落盘立即补发（Minor b：不能让最后一次拖动的值永远留在定时器里）。 */
  function closeAaPanel() {
    flushSettingsSave();
    aaPanel.hidden = true;
    aaToggle.setAttribute('aria-expanded', 'false');
  }

  function toggleAaPanel() {
    if (aaPanel.hidden) {
      openAaPanel();
    } else {
      closeAaPanel();
    }
  }

  /**
   * 点击浮层外部关闭（Aa 面板与工具条最近菜单各自判断；面板/触发按钮内部的点击不关闭，
   * 触发按钮那一下会在打开后冒泡到这里）。
   */
  function onDocumentClick(event) {
    const target = event.target;
    if (!target) {
      return;
    }
    if (!aaPanel.hidden && !aaPanel.contains(target) && !aaToggle.contains(target)) {
      closeAaPanel();
    }
    if (!recentMenu.hidden && !recentMenu.contains(target) && !recentToggle.contains(target)) {
      closeRecentMenu();
    }
  }

  /**
   * Aa 面板控件变更（input 覆盖滑杆拖动，change 覆盖下拉选择/滑杆松手）→ 即时应用；
   * 滑杆拖动中的 input 落盘走 300ms 防抖，change（松手）与下拉立刻落盘。
   */
  function onAaControlChange(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const control = target.closest('[data-setting]');
    if (!control || !aaPanel.contains(control)) {
      return;
    }
    const key = control.dataset.setting;
    const value = coerceSettingValue(key, control.value);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return;
    }
    updateSettings({ [key]: value }, { deferSave: event.type === 'input' });
  }

  // ── 工具条悬浮（Task 12） ──
  let toolbarHideTimer = null;
  // Minor f：自动隐藏到点时最近菜单还开着 → 先不隐藏，等菜单关闭后再隐藏
  let toolbarHidePendingForMenu = false;

  /** 显示悬浮工具条（取消正在等待的自动隐藏）。 */
  function showToolbar() {
    root.dataset.toolbar = 'shown';
    toolbarHidePendingForMenu = false;
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
  }

  /** 立即隐藏工具条并取消等待中的隐藏定时器。 */
  function hideToolbar() {
    toolbarHidePendingForMenu = false;
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
    root.dataset.toolbar = 'hidden';
  }

  /**
   * 焦点是否落在工具条/浮层面板内（修复波 B-键盘可达性）：键盘用户在工具条按钮/最近菜单/Aa 面板里
   * 操作时不能因为鼠标离开就隐藏工具条，否则焦点元素不可见。
   */
  function isFocusInsideOverlays() {
    const active = typeof document.activeElement === 'object' ? document.activeElement : null;
    if (!active) {
      return false;
    }
    return toolbar.contains(active) || aaPanel.contains(active) || recentMenu.contains(active);
  }

  /** 800ms 后自动隐藏（鼠标离开工具条时调用；期间再进入/移到顶部会取消）。 */
  function scheduleToolbarHide() {
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
    }
    toolbarHideTimer = setTimeout(() => {
      toolbarHideTimer = null;
      if (!recentMenu.hidden || isFocusInsideOverlays()) {
        // 菜单开着或焦点仍在工具条/浮层内：工具条保持可见，等菜单关闭/焦点离开后再隐藏
        toolbarHidePendingForMenu = true;
        return;
      }
      root.dataset.toolbar = 'hidden';
    }, TOOLBAR_HIDE_DELAY_MS);
  }

  /** focusin：焦点进入工具条/浮层时显示工具条（键盘 Tab 到隐藏工具条里的按钮也能看见）。 */
  function onOverlayFocusIn() {
    showToolbar();
  }

  /** focusout：焦点离开工具条/浮层后按常规延迟隐藏（工具条已显示时才需要）。 */
  function onOverlayFocusOut(event) {
    if (root.dataset.toolbar !== 'shown') {
      return;
    }
    const next = event && event.relatedTarget;
    if (next && (toolbar.contains(next) || aaPanel.contains(next) || recentMenu.contains(next))) {
      return;
    }
    scheduleToolbarHide();
  }

  /** 鼠标进入窗口顶部 40px 区域：显示工具条（隐藏时也可唤出）。 */
  function onMouseMove(event) {
    const y = Number(event && event.clientY);
    if (Number.isFinite(y) && y <= TOOLBAR_HOVER_ZONE_PX) {
      showToolbar();
    }
  }

  function onToolbarEnter() {
    showToolbar();
  }

  function onToolbarLeave() {
    scheduleToolbarHide();
  }

  // ── 位置记忆与阅读 chrome（Task 12） ──

  /** 更新进度条宽度与回到顶部显隐（scroll 事件与 load 恢复位置后都调用）。 */
  function refreshChrome() {
    updateChrome({ scroller: content, progressEl, backToTopEl });
  }

  function onContentScroll() {
    refreshChrome();
  }

  /** 平滑回到正文顶部（回到顶部按钮、位置恢复 toast 的 action 共用）。 */
  function scrollToTop() {
    if (typeof content.scrollTo === 'function') {
      content.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      content.scrollTop = 0;
    }
  }

  /** 可滚动高度（scrollHeight - clientHeight，负值归 0）。 */
  function scrollableHeight() {
    const height = Number(content.scrollHeight);
    const client = Number(content.clientHeight);
    return Math.max(0, (Number.isFinite(height) ? height : 0) - (Number.isFinite(client) ? client : 0));
  }

  /**
   * 分块文档的字节进度（Important 1）：返回 null 表示「不是分块 / 已全部渲染」，
   * 位置追踪这时用真实 scrollHeight；否则返回已渲染块累计源码字节与全文 UTF-8 字节，
   * 由 chrome.js 的 estimateTotalHeight 外推全文高度（首屏只渲染前缀时也能得到真实位置）。
   */
  function readChunkBytes() {
    const info = state.chunkBytes;
    if (!state.chunked || !info) {
      return null;
    }
    if (!(info.renderedBlocks > 0 && info.renderedBytes > 0)) {
      return null;
    }
    if (info.renderedBlocks >= info.totalBlocks) {
      return null;
    }
    return { renderedBytes: info.renderedBytes, totalBytes: info.totalBytes };
  }

  /**
   * 恢复阅读位置：load 带 position 时按比例写 scrollTop（夹紧 [0,1]），并提示可点击回到顶部；
   * 没有 position（新文档/文件被外部修改换了 key）时回到顶部，不沿用上一份文档的滚动位置（T10 Minor）。
   * 分块/大文件模式首屏只渲染了预算内的块，scrollHeight 远小于全文——先 renderAll 补全，
   * 再按实时 scrollHeight 计算，否则恢复位置会严重偏前（裁定 3）。ratio=0（回到顶部）无需补全全量。
   * T12 评审 Minor c/d：position=0 或内容不可滚动时不弹「已回到上次位置」；同步 renderAll 之前
   * 的「正在恢复…」toast 无法在这一帧绘制（会与最终提示叠加），已去掉，只保留最终提示。
   */
  function restoreScrollPosition() {
    const position = state.position;
    if (position === null) {
      content.scrollTop = 0;
      refreshChrome();
      return;
    }
    const ratio = Math.min(1, Math.max(0, position));
    if (state.chunked && ratio > 0) {
      try {
        state.chunked.renderAll();
      } catch {
        // 补全失败时仍按当前（首屏）高度恢复，不能因为位置恢复让正文消失
      }
    }
    const scrollable = scrollableHeight();
    content.scrollTop = ratio * scrollable;
    refreshChrome();
    if (ratio > 0 && scrollable > 0) {
      showToast('已回到上次位置 · 回到顶部', 'info', { actionText: '回到顶部', onAction: scrollToTop });
    }
  }

  /**
   * 解绑上一次 load 的位置追踪器（换文档/销毁时调用，避免监听器与定时器泄漏）。
   * Important 2：destroy 前先 flush——切换文档时 ≤500ms 节流窗口内的位置不能丢；
   * 此时 tracker 还带着旧 key，发出去的是旧文档的最后位置。
   */
  function stopPositionTracker() {
    const tracker = state.positionTracker;
    if (!tracker) {
      return;
    }
    state.positionTracker = null;
    tracker.flush();
    tracker.destroy();
  }

  /** 每次 load 用新 key 重建位置追踪器（滚动节流 500ms → savePosition；分块未补全时按估算全文高度）。 */
  function startPositionTracker() {
    stopPositionTracker();
    if (!state.key) {
      return;
    }
    state.positionTracker = createPositionTracker({
      scroller: content,
      key: state.key,
      emit: (key, ratio) => send('savePosition', { key, ratio }),
      readChunkBytes,
      estimateTotalHeight,
    });
    state.positionTracker.start();
  }

  /** F5：先把节流中的位置强制落盘，再请求宿主重读当前文件（宿主按新 key 重新查位置）。 */
  function reloadDocument() {
    if (!state.loaded) {
      return;
    }
    if (state.positionTracker) {
      state.positionTracker.flush();
    }
    send('reload');
  }

  /**
   * 导出 PDF（Ctrl+E / 工具条按钮）：无当前文档时只提示；有文档则把「文档名去扩展名 + .pdf」
   * 作为建议名交给宿主弹保存对话框（打印模式与 PrintToPdf 全在宿主侧完成）。
   */
  function exportCurrentPdf() {
    if (!state.path) {
      showToast('请先打开文档', 'warn');
      return;
    }
    send('exportPdf', { suggestedName: pdfSuggestedFileName(state.path) });
  }

  // ── 最近文件（Task 12） ──
  /** 打开最近文件项：走 openRecent（宿主只接受 recent.json 里命中的路径，C1）。 */
  function openRecentFile(path) {
    if (typeof path === 'string' && path !== '') {
      send('openRecent', { path });
    }
  }

  /** Esc / 关闭按钮：空白启动页收起最近文件面板（load 之后面板本来就不在）。 */
  function closeRecentPanel() {
    content.replaceChildren();
  }

  /** 空白启动页：在 #content 渲染最近文件面板（标题 + 列表 + 「打开文件」按钮 + 拖入/Ctrl+O 提示）。 */
  function renderRecentPanel() {
    content.replaceChildren(
      renderRecent(state.recent, {
        onOpen: openRecentFile,
        onClose: closeRecentPanel,
        // 修复波 B-§5.11：空白启动也要有可点击的「打开文件」入口（不依赖用户记住 Ctrl+O）。
        onPickFile: () => send('pickFile'),
      }),
    );
  }

  // ── 工具条「最近」菜单（spec §5.6：与空白启动页共用同一份 state.recent） ──

  /** 用当前 state.recent 渲染菜单内容（复用 renderRecent 的同一列表与键盘行为）。 */
  function renderRecentMenu() {
    recentMenu.replaceChildren(
      renderRecent(state.recent, {
        onOpen: openRecentFromMenu,
        onClose: closeRecentMenu,
        onPickFile: () => {
          closeRecentMenu();
          send('pickFile');
        },
      }),
    );
  }

  /** 菜单项选中：先收起菜单，再交给宿主按最近列表校验后打开。 */
  function openRecentFromMenu(path) {
    closeRecentMenu();
    openRecentFile(path);
  }

  /** 打开菜单（每次打开都按最新最近列表重渲染）并同步按钮展开状态。 */
  function openRecentMenu() {
    renderRecentMenu();
    recentMenu.hidden = false;
    recentToggle.setAttribute('aria-expanded', 'true');
    // Minor a：打开后焦点落到第一项，↑↓/Enter 立刻可用（焦点必须在解除 hidden 之后设置，
    // 隐藏容器里的元素无法获得焦点）。菜单项是原生 button，Tab 仍可离开。
    const first = recentMenu.querySelector('[data-path]');
    if (first && typeof first.focus === 'function') {
      first.focus();
    }
  }

  /** 收起菜单并同步按钮展开状态（Esc / 点击外部 / 选中项 / load 都走这里）。 */
  function closeRecentMenu() {
    recentMenu.hidden = true;
    recentToggle.setAttribute('aria-expanded', 'false');
    // Minor f：自动隐藏到点时因菜单开着被推迟的隐藏，现在补上
    if (toolbarHidePendingForMenu) {
      hideToolbar();
    }
  }

  function toggleRecentMenu() {
    if (recentMenu.hidden) {
      openRecentMenu();
    } else {
      closeRecentMenu();
    }
  }

  /** Alt+←/→：按最近文件顺序切换上一份（更早）/下一份（更新）；走 openRecent 受限入口。 */
  function openAdjacentRecent(direction) {
    const target = nextRecentPath(state.recent, state.path, direction);
    if (target) {
      send('openRecent', { path: target });
    }
  }

  /**
   * 全局快捷键（输入框内不触发）：
   * Esc 关浮层（Aa/最近面板/工具条）；Alt 显示工具条；Alt+←/→ 切换最近文件；Alt+T 主题循环、Alt+A 关于；F5 重载；
   * Ctrl+O 打开文件、Ctrl+Shift+O 打开文件夹（宿主弹系统对话框）；
   * Ctrl+B 侧栏显隐、Ctrl+= / Ctrl+- 字号 ±1、Ctrl+0 重置 16、Ctrl+, 排版面板、Ctrl+Shift+C 定位文件。
   */
  function onKeyDown(event) {
    if (!event || event.defaultPrevented) {
      return;
    }
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Escape') {
      // Minor g：Esc 在可编辑控件内属于控件自己（清空/取消输入），不能顺带隐藏工具条
      const editable = isEditableTarget(event.target);
      if (!aaPanel.hidden) {
        closeAaPanel();
      } else if (!recentMenu.hidden) {
        closeRecentMenu();
      } else if (!state.loaded && content.querySelector('.recent-panel')) {
        closeRecentPanel();
      }
      if (!editable) {
        hideToolbar();
      }
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    // Alt 相关：Alt 显示工具条，Alt+←/→ 在最近文件列表里切换（不抢浏览器默认行为）；
    // 修复波 B-键盘可达性：Alt+T 主题三态循环、Alt+A 打开关于（README 快捷键表同步）。
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      if (key === 'ArrowLeft') {
        event.preventDefault();
        openAdjacentRecent('older');
        return;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        openAdjacentRecent('newer');
        return;
      }
      if (key === 't' || key === 'T') {
        event.preventDefault();
        updateSettings({ theme: nextTheme(state.settings.theme) });
        return;
      }
      if (key === 'a' || key === 'A') {
        event.preventDefault();
        send('openAbout');
        return;
      }
    }
    if (key === 'Alt') {
      showToolbar();
      scheduleToolbarHide();
      return;
    }
    if (key === 'F5') {
      event.preventDefault();
      reloadDocument();
      return;
    }

    const ctrl = Boolean(event.ctrlKey || event.metaKey);
    if (!ctrl || event.altKey) {
      return;
    }

    if (key === 'o' || key === 'O') {
      // Ctrl+O 打开文件 / Ctrl+Shift+O 打开文件夹：系统对话框由宿主弹，前端只发意图
      event.preventDefault();
      send(event.shiftKey ? 'pickFolder' : 'pickFile');
      return;
    }
    if ((key === 'c' || key === 'C') && event.shiftKey) {
      event.preventDefault();
      if (state.path) {
        send('showInFolder', { path: state.path });
      }
      return;
    }
    if (key === 'b' || key === 'B') {
      event.preventDefault();
      updateSettings({ tocVisible: !state.settings.tocVisible });
      return;
    }
    if (key === 'e' || key === 'E') {
      // Ctrl+E 导出 PDF（Task 15）：与工具条「导出 PDF」同一入口
      event.preventDefault();
      exportCurrentPdf();
      return;
    }
    if (key === '=' || key === '+') {
      event.preventDefault();
      updateSettings({ fontSize: state.settings.fontSize + 1 });
      return;
    }
    if (key === '-' || key === '_') {
      event.preventDefault();
      updateSettings({ fontSize: state.settings.fontSize - 1 });
      return;
    }
    if (key === '0') {
      event.preventDefault();
      updateSettings({ fontSize: 16 });
      return;
    }
    if (key === ',' || key === '<') {
      event.preventDefault();
      toggleAaPanel();
    }
  }

  function renderLoad(payload) {
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
    state.path = typeof payload.path === 'string' ? payload.path : '';
    state.key = typeof payload.key === 'string' ? payload.key : '';
    state.baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl : '';
    // §5.11 调试字段：宿主附带编码名（旧宿主不传时按 utf-8），只记录到 state，供排查用。
    state.encoding = typeof payload.encoding === 'string' ? payload.encoding : 'utf-8';
    state.position = typeof payload.position === 'number' && Number.isFinite(payload.position) ? payload.position : null;
    state.loaded = true;
    // 新文档先收起上一份的错误条（宿主的编码/二进制/打开失败通知会在 load 之后重新下发）
    hideErrorBar();
    // Task 15：有文档才允许导出 PDF（与 Ctrl+E 的「请先打开文档」提示同口径）
    exportPdfButton.disabled = !state.path;
    // 文档已打开：工具条最近菜单不再需要（避免浮层盖住新正文）
    closeRecentMenu();
    // 换文档先解绑旧位置追踪器（旧 key 的滚动上报不能带到新文档）
    stopPositionTracker();

    // 设置先落地（主题先写 data-theme 再重绘正文，避免切换白闪）：默认值 + 宿主下发值，全部夹紧。
    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    state.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    applySettings(state.settings);
    applyThemeState();
    applyUiStyleState();
    applyTocVisibility();
    syncAaControls();
    syncTocResizerWidth();

    const started = now();
    let tocCount = 0;
    try {
      renderer.render(markdown);
      // 契约（spec §4.4）：renderDone{path, elapsedMs, tocCount, bytes}；tocCount 复用渲染期 extractHeadings 的结果
      tocCount = tocController.getExtractedCount();
    } catch (error) {
      // 修复波 B-§5.11：渲染管线整体失败 → 转义 <pre> 兜底 + 持久错误条；renderDone 仍照常发出。
      try {
        console.warn('[JJ] renderLoad 渲染失败，已降级为纯文本', error);
      } catch {
        // 无 console 环境忽略
      }
      renderer.renderFallback(markdown);
      tocCount = 0;
      showErrorBar('渲染失败，已以纯文本显示');
    }
    const elapsedMs = Math.max(0, now() - started);

    send('renderDone', {
      path: state.path,
      elapsedMs,
      tocCount,
      bytes: utf8Length(markdown),
    });
    // Task 12：渲染完成后恢复位置（无 position 时归零），再开始按新 key 节流上报
    restoreScrollPosition();
    startPositionTracker();
    // Task 14：新文档决定侧栏模式（根内保持树并高亮；根外恢复大纲）
    browser.syncForDocument();
    // 新文档 load 后（首帧布局 / 字体就绪可能改变标题位置）：下一帧再校准一次标题 top
    scheduleRefreshHeadingTops();
  }

  /** 消息分发：load/toast/notice/settings/recent/assocState/dirListing；未知 type 静默忽略（坏消息不能中断 shell）。 */
  function onMessage(message) {
    // 修复波 B-§5.11：单条坏消息/渲染异常不能中断 shell，也不让异常冒泡到 WebView 消息监听。
    try {
      dispatchMessage(message);
    } catch (error) {
      try {
        console.warn('[JJ] 处理宿主消息失败', error);
      } catch {
        // 无 console 环境忽略
      }
      showErrorBar('处理消息失败，部分界面可能未更新');
    }
  }

  /** 把宿主下发的持久偏好应用到界面（空白启动页与 load 之后都走同一入口）。 */
  function applyIncomingSettings(payload) {
    const incoming = payload && typeof payload === 'object' ? payload : {};
    state.settings = normalizeSettings({ ...state.settings, ...incoming });
    applySettings(state.settings);
    applyThemeState();
    applyUiStyleState();
    applyTocVisibility();
    syncAaControls();
    syncTocResizerWidth();
    scheduleRefreshHeadingTops();
  }

  function dispatchMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    switch (type) {
      case 'load':
        renderLoad(payload);
        break;
      case 'toast':
        showToast(payload.text, payload.level);
        // 读取目录失败时宿主只发 warn/error toast：浏览控制器据此把在途目录标为失败（单击可重试）
        browser.onToast(payload);
        break;
      case 'notice':
        // §5.11：宿主主动的持久提示（编码异常 / 二进制拒绝 / 文件打不开）。
        // persistent !== false 显示为可关闭错误条；否则退回 3 秒 toast（旧宿主兼容）。
        if (payload.persistent === false) {
          showToast(payload.text, payload.level);
        } else {
          showErrorBar(payload.text, { level: payload.level === 'warn' ? 'warn' : 'error' });
        }
        break;
      case 'settings':
        // 修复波 B-空白启动：宿主在 shellReady 后下发已持久化偏好，未打开文档也应用主题/字号。
        applyIncomingSettings(payload);
        break;
      case 'recent':
        // 宿主每次打开文档后都会推最新列表；空白启动页用它渲染面板（已有文档时只更新 state）。
        // 工具条最近菜单与空白页共用 state.recent：菜单打开时就地刷新同一份列表。
        state.recent = normalizeRecentItems(payload.items);
        if (!state.loaded) {
          renderRecentPanel();
        }
        if (!recentMenu.hidden) {
          renderRecentMenu();
        }
        break;
      case 'assocState':
        // Task 16：记录关联状态，并把「关于」按钮的 title 换成用户能直接看懂的默认程序提示。
        state.assocState = { registered: Boolean(payload.registered), isDefault: Boolean(payload.isDefault) };
        aboutButton.title = state.assocState.isDefault
          ? '默认 .md 程序'
          : '尚未设为默认 .md 程序（可在关于中设置）';
        break;
      case 'dirListing':
        state.dirListing = payload;
        // 根列表切根 / 子列表填树、迟到旧根子列表丢弃、当前文档高亮都在 browse.js。
        browser.applyListing(payload);
        break;
      default:
        break;
    }
  }

  // 首屏（load 之前）就用默认偏好：主题/排版/侧栏状态先落地，宿主推 load 时只做增量。
  applySettings(state.settings);
  applyThemeState();
  applyUiStyleState();
  applyTocVisibility();
  syncAaControls();
  syncTocResizerWidth();
  tocNav.replaceChildren(buildToc([]));
  browser.showTocMode();
  renderRecentPanel();
  refreshChrome();

  // Task 13：工具条打开入口与 Ctrl+O / Ctrl+Shift+O 走同一条消息（宿主弹系统对话框）
  openFileButton.addEventListener('click', () => {
    send('pickFile');
  });
  openFolderButton.addEventListener('click', () => {
    send('pickFolder');
  });
  // Task 15：工具条「导出 PDF」与 Ctrl+E 共用 exportCurrentPdf（无文档时提示，不发消息）
  exportPdfButton.addEventListener('click', exportCurrentPdf);
  // Task 16：工具条「关于」→ 宿主打开模态关于面板（不经过快捷键；面板里再做关联设置）
  aboutButton.addEventListener('click', () => {
    send('openAbout');
  });
  themeToggle.addEventListener('click', () => {
    updateSettings({ theme: nextTheme(state.settings.theme) });
  });
  // 界面美化波：工具条「主题」（鲸鱼图标）在 reader ↔ whale 间切换（与 Aa 面板下拉共用 uiStyle 字段）
  uiStyleToggle.addEventListener('click', () => {
    updateSettings({ uiStyle: nextUiStyle(state.settings.uiStyle) });
  });
  tocToggle.addEventListener('click', () => {
    updateSettings({ tocVisible: !state.settings.tocVisible });
  });
  aaToggle.addEventListener('click', toggleAaPanel);
  recentToggle.addEventListener('click', toggleRecentMenu);
  aaPanel.addEventListener('input', onAaControlChange);
  aaPanel.addEventListener('change', onAaControlChange);
  // 鼠标离开面板：防抖中的滑杆 patch 立即补发（Minor b），不能让最后一次拖动只在定时器里
  aaPanel.addEventListener('mouseleave', flushSettingsSave);
  toc.addEventListener('click', onTocClick);
  // 评审 #1：内联 [TOC] 在 #content 里，点击委托到这里（与侧栏共用 scrollToHeading 的定位逻辑）
  content.addEventListener('click', onContentClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocumentClick);
  // 修复波 B-§5.11：错误条/大文件横幅可手动关闭（持久显示，不自动消失）。
  errorBarClose.addEventListener('click', hideErrorBar);
  hugeBannerClose.addEventListener('click', hideHugeBanner);
  // 键盘可达性：焦点进入工具条/浮层时保持工具条可见；离开后再按 800ms 规则隐藏。
  toolbar.addEventListener('focusin', onOverlayFocusIn);
  aaPanel.addEventListener('focusin', onOverlayFocusIn);
  recentMenu.addEventListener('focusin', onOverlayFocusIn);
  document.addEventListener('focusout', onOverlayFocusOut);
  // Task 12：滚动驱动进度条/回到顶部；鼠标进顶部 40px 显示工具条，离开工具条 800ms 隐藏
  content.addEventListener('scroll', onContentScroll, { passive: true });
  document.addEventListener('mousemove', onMouseMove, { passive: true });
  toolbar.addEventListener('mouseenter', onToolbarEnter);
  toolbar.addEventListener('mouseleave', onToolbarLeave);

  // 图片异步加载成功 / 失败换占位都会让后续标题整体位移：error 事件不冒泡，必须在 #content 捕获阶段监听。
  function onContentResourceSettled(event) {
    const target = event && event.target;
    if (!target || target.tagName !== 'IMG') {
      return;
    }
    scheduleRefreshHeadingTops();
  }
  content.addEventListener('load', onContentResourceSettled, true);
  content.addEventListener('error', onContentResourceSettled, true);

  // <details> 展开/折叠会改变正文高度（图片同理）。toggle 事件不冒泡，只能在 #content 捕获阶段收到；
  // 展开会让后续标题整体下移，因此同样合并到下一帧重采集标题 top。
  function onContentToggle(event) {
    const target = event && event.target;
    if (!target || target.tagName !== 'DETAILS') {
      return;
    }
    scheduleRefreshHeadingTops();
  }
  content.addEventListener('toggle', onContentToggle, true);

  // 窗口尺寸变化 / 图片撑开正文都会改 #content 尺寸：ResizeObserver 可用时订阅（jsdom 无该 API，守卫跳过）。
  let contentResizeObserver = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    try {
      contentResizeObserver = new globalThis.ResizeObserver(() => scheduleRefreshHeadingTops());
      contentResizeObserver.observe(content);
    } catch {
      contentResizeObserver = null;
    }
  }

  /** 卸下全局监听、滚动联动、标题位置刷新与分隔条拖拽（测试/多实例装配用；WebView2 页面生命周期内不需要调用）。 */
  function destroy() {
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('click', onDocumentClick);
    toc.removeEventListener('click', onTocClick);
    content.removeEventListener('click', onContentClick);
    content.removeEventListener('scroll', onContentScroll);
    document.removeEventListener('mousemove', onMouseMove);
    toolbar.removeEventListener('mouseenter', onToolbarEnter);
    toolbar.removeEventListener('mouseleave', onToolbarLeave);
    content.removeEventListener('load', onContentResourceSettled, true);
    content.removeEventListener('error', onContentResourceSettled, true);
    content.removeEventListener('toggle', onContentToggle, true);
    if (contentResizeObserver) {
      contentResizeObserver.disconnect();
      contentResizeObserver = null;
    }
    aaPanel.removeEventListener('input', onAaControlChange);
    aaPanel.removeEventListener('change', onAaControlChange);
    aaPanel.removeEventListener('mouseleave', flushSettingsSave);
    // 设置落盘器：解绑 pagehide/visibilitychange 并补发 pending patch（原先只 flush，监听会泄漏）
    settingsSaver.destroy();
    recentToggle.removeEventListener('click', toggleRecentMenu);
    errorBarClose.removeEventListener('click', hideErrorBar);
    hugeBannerClose.removeEventListener('click', hideHugeBanner);
    toolbar.removeEventListener('focusin', onOverlayFocusIn);
    aaPanel.removeEventListener('focusin', onOverlayFocusIn);
    recentMenu.removeEventListener('focusin', onOverlayFocusIn);
    document.removeEventListener('focusout', onOverlayFocusOut);
    // 浏览控制器的工具条监听（根名切回树 / 大纲返回）与内部状态一并清理
    browser.destroy();
    tocResizerControl.destroy();
    // Task 11：分块渲染器（哨兵观察器）与 huge-mode class 一并清理，避免跨实例/跨文档残留
    renderer.clearChunked();
    document.body.classList.remove('huge-mode');
    // Task 12：位置追踪器与标题/TOC 控制器
    stopPositionTracker();
    tocController.destroy();
    clearToastContainer(toast);
    // Task 15：解除打印流程的 post 引用（仍是本次装配时才清），避免销毁后继续往旧通道发消息
    if (globalThis.JJ && globalThis.JJ.__post === send) {
      delete globalThis.JJ.__post;
    }
    // Task 15 修复：同样解除导出前的全文渲染入口
    if (globalThis.JJ && globalThis.JJ.__ensureAllRendered === ensureAllRendered) {
      delete globalThis.JJ.__ensureAllRendered;
    }
  }

  // 握手：shell 装配完成（监听器已就绪）→ 通知宿主可以推 load 了（只发一次）。
  send('shellReady', {});

  return { root, onMessage, destroy };
}
