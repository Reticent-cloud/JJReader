// shell 总装：固定 DOM 骨架、消息分发、正文渲染与 renderDone 回报。
// 正文走 JJ.renderMarkdown（Task 5 起为 markdown-it 引擎），引擎缺失时降级 escapeHtml + <pre> 保证不白屏。
// Task 10 起装配阅读体验：TOC 侧栏（标题 id 兜底 + 滚动联动 + 拖拽调宽）、主题三态、排版面板（Aa）与快捷键。
// Task 12 起装配最近文件、位置记忆、阅读进度条/回到顶部、悬浮工具条与 F5/Alt+←→/Ctrl+Shift+C。
// 模块拆分（T10 评审 carry-forward）：工具条与 Aa 面板 → toolbar.js；最近文件面板 → recent.js；
// 位置追踪/进度条/回到顶部/toast → chrome.js；标题 id + TOC/滚动联动 → headings.js；正文渲染管线 → render.js。
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
import {
  clearToastContainer,
  createChromeElements,
  createPositionTracker,
  setToastContainer,
  showToast,
  updateChrome,
} from './chrome.js';
import { createTocController } from './headings.js';
import { nextRecentPath, normalizeRecentItems, renderRecent } from './recent.js';
import { createRenderer } from './render.js';
import { createTocResizer } from './resizer.js';
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

  // 固定骨架：#app > header#toolbar、aside#toc、div.toc-resizer（拖拽调宽分隔条）、main#content（滚动容器）、
  // div#progress（阅读进度条）、button#back-to-top、div#aa-panel、div#recent-menu（工具条最近菜单）、div#toast。
  // 分隔条绝对定位在侧栏右缘（不占网格列），折叠时隐藏；进度条/回到顶部/工具条都是 fixed 悬浮层。
  root.replaceChildren();
  const toolbarParts = createToolbar();
  const toolbar = toolbarParts.element;
  const { tocToggle, recentToggle, themeToggle, aaToggle } = toolbarParts;
  const toc = document.createElement('aside');
  toc.id = 'toc';
  toc.setAttribute('aria-label', '大纲');
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
  const { progress, progressEl, backToTopEl } = createChromeElements();
  root.append(toolbar, toc, tocResizer, content, progress, backToTopEl, aaPanel, recentMenu, toast);
  setToastContainer(toast);
  // 悬浮工具条默认隐藏：鼠标进顶部 40px 或按 Alt 才显示（隐藏时键盘快捷键照常可用）。
  root.dataset.toolbar = 'hidden';

  // TOC/标题 id 控制器：持有标题快照、滚动联动 spy 与 TOC 高亮（实现见 headings.js）。
  const tocController = createTocController({ content, toc });

  const state = {
    path: '',
    key: '',
    baseUrl: '',
    settings: normalizeSettings(DEFAULT_SETTINGS),
    position: null,
    assoc: null,
    dirListing: null,
    // Task 12：是否收到过 load（空白启动页显示最近文件面板）、最近文件列表（Alt+←/→ 切换用）
    loaded: false,
    recent: [],
    // Task 11：大文件模式标记（关闭高亮、停用滚动联动）、分块渲染器句柄
    huge: false,
    chunked: null,
    // Task 12：位置追踪器（每次 load 重建；节流上报 savePosition）
    positionTracker: null,
  };

  // 正文渲染管线（兜底/分块/front matter/增强，实现见 render.js）；它读写 state.huge / state.chunked。
  const renderer = createRenderer({
    content,
    getState: () => state,
    tocController,
    send,
    showToast,
  });

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

  /** 侧栏显隐：CSS 用 #app[data-toc="hidden"] 折叠（保持 DOM，切回不重建 TOC）；折叠时分隔条同步隐藏。 */
  function applyTocVisibility() {
    const visible = state.settings.tocVisible;
    root.setAttribute('data-toc', visible ? 'visible' : 'hidden');
    tocToggle.setAttribute('aria-pressed', String(visible));
    tocToggle.classList.toggle('active', visible);
    tocResizer.hidden = !visible;
  }

  /** Aa 面板控件回显当前设置（快捷键改字号后滑杆同步）。 */
  function syncAaControls() {
    for (const control of aaPanel.querySelectorAll('[data-setting]')) {
      const key = control.dataset.setting;
      const value = state.settings[key];
      if (value === undefined) {
        continue;
      }
      control.value = String(value);
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

  /**
   * 唯一设置入口：归一 → 只算变化字段 → 先应用（写 CSS 变量/主题/侧栏）→ 再上报 saveSettings{patch}。
   * 没有变化时什么都不做（不重复发消息）。
   * @returns {object} 实际发送的 patch（无变化为空对象）
   */
  function updateSettings(next) {
    const merged = normalizeSettings({ ...state.settings, ...(next && typeof next === 'object' ? next : {}) });
    const patch = settingsPatch(state.settings, merged);
    if (Object.keys(patch).length === 0) {
      return {};
    }
    state.settings = merged;
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      applyThemeState();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'tocVisible')) {
      applyTocVisibility();
    }
    applySettings(state.settings);
    syncAaControls();
    // 字号/行距/行宽（以及侧栏宽度）变化都会重排正文：刷新标题位置快照
    scheduleRefreshHeadingTops();
    send('saveSettings', { patch });
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
   * 正文内 `[TOC]` 内联目录点击（评审 #1）：委托到 #content，只接管 nav.toc-inline 内的锚点链接。
   * 脚注回跳等其它站内锚点保持浏览器默认行为；分块模式下目标未渲染时先 renderAll 再实时定位。
   */
  function onContentClick(event) {
    tocController.handleInlineTocClick(event, chunkRenderOptions());
  }

  function openAaPanel() {
    aaPanel.hidden = false;
    aaToggle.setAttribute('aria-expanded', 'true');
  }

  function closeAaPanel() {
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

  /** Aa 面板控件变更（input 覆盖滑杆拖动，change 覆盖下拉选择）→ 即时应用并持久化。 */
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
    updateSettings({ [key]: value });
  }

  // ── 工具条悬浮（Task 12） ──
  let toolbarHideTimer = null;

  /** 显示悬浮工具条（取消正在等待的自动隐藏）。 */
  function showToolbar() {
    root.dataset.toolbar = 'shown';
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
  }

  /** 立即隐藏工具条并取消等待中的隐藏定时器。 */
  function hideToolbar() {
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
    root.dataset.toolbar = 'hidden';
  }

  /** 800ms 后自动隐藏（鼠标离开工具条时调用；期间再进入/移到顶部会取消）。 */
  function scheduleToolbarHide() {
    if (toolbarHideTimer !== null) {
      clearTimeout(toolbarHideTimer);
    }
    toolbarHideTimer = setTimeout(() => {
      toolbarHideTimer = null;
      root.dataset.toolbar = 'hidden';
    }, TOOLBAR_HIDE_DELAY_MS);
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
   * 恢复阅读位置：load 带 position 时按比例写 scrollTop（夹紧 [0,1]），并提示可点击回到顶部；
   * 没有 position（新文档/文件被外部修改换了 key）时回到顶部，不沿用上一份文档的滚动位置（T10 Minor）。
   * 分块/大文件模式首屏只渲染了预算内的块，scrollHeight 远小于全文——先 renderAll 补全，
   * 再按实时 scrollHeight 计算，否则恢复位置会严重偏前（裁定 3）。ratio=0（回到顶部）无需补全全量。
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
      showToast('正在恢复到上次阅读位置…', 'info');
      try {
        state.chunked.renderAll();
      } catch {
        // 补全失败时仍按当前（首屏）高度恢复，不能因为位置恢复让正文消失
      }
    }
    content.scrollTop = ratio * scrollableHeight();
    refreshChrome();
    if (ratio > 0) {
      showToast('已回到上次位置 · 回到顶部', 'info', { actionText: '回到顶部', onAction: scrollToTop });
    }
  }

  /** 解绑上一次 load 的位置追踪器（换文档/销毁时调用，避免监听器与定时器泄漏）。 */
  function stopPositionTracker() {
    if (state.positionTracker) {
      state.positionTracker.destroy();
      state.positionTracker = null;
    }
  }

  /** 每次 load 用新 key 重建位置追踪器（滚动节流 500ms → savePosition）。 */
  function startPositionTracker() {
    stopPositionTracker();
    if (!state.key) {
      return;
    }
    state.positionTracker = createPositionTracker({
      scroller: content,
      key: state.key,
      emit: (key, ratio) => send('savePosition', { key, ratio }),
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

  // ── 最近文件（Task 12） ──
  /** 打开最近文件项：绝对路径交给宿主（宿主也接受相对当前文档目录的路径）。 */
  function openRecentFile(path) {
    if (typeof path === 'string' && path !== '') {
      send('openFile', { relPath: path });
    }
  }

  /** Esc / 关闭按钮：空白启动页收起最近文件面板（load 之后面板本来就不在）。 */
  function closeRecentPanel() {
    content.replaceChildren();
  }

  /** 空白启动页：在 #content 渲染最近文件面板（标题 + 列表 + 拖入/Ctrl+O 提示）。 */
  function renderRecentPanel() {
    content.replaceChildren(
      renderRecent(state.recent, { onOpen: openRecentFile, onClose: closeRecentPanel }),
    );
  }

  // ── 工具条「最近」菜单（spec §5.6：与空白启动页共用同一份 state.recent） ──

  /** 用当前 state.recent 渲染菜单内容（复用 renderRecent 的同一列表与键盘行为）。 */
  function renderRecentMenu() {
    recentMenu.replaceChildren(
      renderRecent(state.recent, { onOpen: openRecentFromMenu, onClose: closeRecentMenu }),
    );
  }

  /** 菜单项选中：先收起菜单，再交给宿主打开（绝对路径按绝对处理）。 */
  function openRecentFromMenu(path) {
    closeRecentMenu();
    openRecentFile(path);
  }

  /** 打开菜单（每次打开都按最新最近列表重渲染）并同步按钮展开状态。 */
  function openRecentMenu() {
    renderRecentMenu();
    recentMenu.hidden = false;
    recentToggle.setAttribute('aria-expanded', 'true');
  }

  /** 收起菜单并同步按钮展开状态（Esc / 点击外部 / 选中项 / load 都走这里）。 */
  function closeRecentMenu() {
    recentMenu.hidden = true;
    recentToggle.setAttribute('aria-expanded', 'false');
  }

  function toggleRecentMenu() {
    if (recentMenu.hidden) {
      openRecentMenu();
    } else {
      closeRecentMenu();
    }
  }

  /** Alt+←/→：按最近文件顺序切换上一份（更早）/下一份（更新）。 */
  function openAdjacentRecent(direction) {
    const target = nextRecentPath(state.recent, state.path, direction);
    if (target) {
      send('openFile', { relPath: target });
    }
  }

  /**
   * 全局快捷键（输入框内不触发）：
   * Esc 关浮层（Aa/最近面板/工具条）；Alt 显示工具条；Alt+←/→ 切换最近文件；F5 重载；
   * Ctrl+B 侧栏显隐、Ctrl+= / Ctrl+- 字号 ±1、Ctrl+0 重置 16、Ctrl+, 排版面板、Ctrl+Shift+C 定位文件。
   */
  function onKeyDown(event) {
    if (!event || event.defaultPrevented) {
      return;
    }
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Escape') {
      if (!aaPanel.hidden) {
        closeAaPanel();
      } else if (!recentMenu.hidden) {
        closeRecentMenu();
      } else if (!state.loaded && content.querySelector('.recent-panel')) {
        closeRecentPanel();
      }
      hideToolbar();
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    // Alt 相关：Alt 显示工具条，Alt+←/→ 在最近文件列表里切换（不抢浏览器默认行为）
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
    state.position = typeof payload.position === 'number' && Number.isFinite(payload.position) ? payload.position : null;
    state.loaded = true;
    // 文档已打开：工具条最近菜单不再需要（避免浮层盖住新正文）
    closeRecentMenu();
    // 换文档先解绑旧位置追踪器（旧 key 的滚动上报不能带到新文档）
    stopPositionTracker();

    // 设置先落地（主题先写 data-theme 再重绘正文，避免切换白闪）：默认值 + 宿主下发值，全部夹紧。
    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    state.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    applySettings(state.settings);
    applyThemeState();
    applyTocVisibility();
    syncAaControls();
    syncTocResizerWidth();

    const started = now();
    renderer.render(markdown);
    // 契约（spec §4.4）：renderDone{path, elapsedMs, tocCount, bytes}；tocCount 复用渲染期 extractHeadings 的结果
    const tocCount = tocController.getExtractedCount();
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
    // 新文档 load 后（首帧布局 / 字体就绪可能改变标题位置）：下一帧再校准一次标题 top
    scheduleRefreshHeadingTops();
  }

  /** 消息分发：load/toast/recent/assocState/dirListing；未知 type 静默忽略（坏消息不能中断 shell）。 */
  function onMessage(message) {
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
        state.assoc = { registered: Boolean(payload.registered), isDefault: Boolean(payload.isDefault) };
        break;
      case 'dirListing':
        state.dirListing = payload;
        break;
      default:
        break;
    }
  }

  // 首屏（load 之前）就用默认偏好：主题/排版/侧栏状态先落地，宿主推 load 时只做增量。
  applySettings(state.settings);
  applyThemeState();
  applyTocVisibility();
  syncAaControls();
  syncTocResizerWidth();
  toc.replaceChildren(buildToc([]));
  renderRecentPanel();
  refreshChrome();

  themeToggle.addEventListener('click', () => {
    updateSettings({ theme: nextTheme(state.settings.theme) });
  });
  tocToggle.addEventListener('click', () => {
    updateSettings({ tocVisible: !state.settings.tocVisible });
  });
  aaToggle.addEventListener('click', toggleAaPanel);
  recentToggle.addEventListener('click', toggleRecentMenu);
  aaPanel.addEventListener('input', onAaControlChange);
  aaPanel.addEventListener('change', onAaControlChange);
  toc.addEventListener('click', onTocClick);
  // 评审 #1：内联 [TOC] 在 #content 里，点击委托到这里（与侧栏共用 scrollToHeading 的定位逻辑）
  content.addEventListener('click', onContentClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocumentClick);
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
    if (contentResizeObserver) {
      contentResizeObserver.disconnect();
      contentResizeObserver = null;
    }
    aaPanel.removeEventListener('input', onAaControlChange);
    aaPanel.removeEventListener('change', onAaControlChange);
    recentToggle.removeEventListener('click', toggleRecentMenu);
    tocResizerControl.destroy();
    // Task 11：分块渲染器（哨兵观察器）与 huge-mode class 一并清理，避免跨实例/跨文档残留
    renderer.clearChunked();
    document.body.classList.remove('huge-mode');
    // Task 12：位置追踪器与标题/TOC 控制器
    stopPositionTracker();
    tocController.destroy();
    clearToastContainer(toast);
  }

  // 握手：shell 装配完成（监听器已就绪）→ 通知宿主可以推 load 了（只发一次）。
  send('shellReady', {});

  return { root, onMessage, destroy };
}
