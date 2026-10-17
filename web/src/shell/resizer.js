// TOC 侧栏拖拽调宽（Task 10 补漏：spec §5.1 要求默认 240 px、可拖 180–360 px）。
// 独立成模块而不是塞进 main.js 的理由：main.js 已 700+ 行且承担消息分发/渲染/设置等总装职责，
// 调宽是自包含的指针交互；本模块只管「按下 → 移动 → 松开」的状态机与指针事件，
// 宽度合法性（clamp）、状态同步与 saveSettings 落盘全部通过 getWidth/onPreview/onCommit 回调
// 交给 shell——保持「拖拽中只预览、松手才按 settingsPatch 口径上报一次」的既有设置通路。
//
// 交互口径：
// - pointerdown 记录起始 clientX 与起始宽；pointermove 把宽度设为 clamp(起始宽 + dx) 并回调 onPreview；
// - pointerup / pointercancel 结束拖拽，按起始宽回调 onCommit（shell 只上报变化字段）；
// - 拖拽期间 preventDefault + 给 <body> 挂 .jj-resizing（CSS 禁选中/保持 col-resize 光标）；
// - 双击重置为 defaultWidth（240）；方向键 ±10（键盘无障碍，属可选增强）。
// jsdom 没有 PointerEvent，测试用 new Event + Object.assign 注入 clientX；本模块只读事件属性，不依赖 PointerEvent 类。

import { TOC_WIDTH_DEFAULT, TOC_WIDTH_MAX, TOC_WIDTH_MIN } from '../settings.js';

/** 键盘步进（方向键 ±10 px）。 */
export const RESIZER_KEYBOARD_STEP = 10;

/** 拖拽期间挂在 <body> 上的类名（layout.css 里禁选中 + 列宽光标）。 */
export const RESIZING_CLASS = 'jj-resizing';

/** 宽度夹紧并取整（与 settings.normalizeTocWidth 同一口径：180–360 的整数）。 */
function clampWidth(value, min, max) {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * 把分隔条变成可拖拽的列宽调节器。
 * @param {{
 *   handle: HTMLElement,
 *   getWidth: () => number,            // 当前宽度（shell 返回 state.settings.tocWidth）
 *   onPreview?: (width: number) => void, // 拖动中：实时写状态 + CSS 变量（不落盘）
 *   onCommit?: (width: number, startWidth: number) => void, // 结束：按起始宽只上报变化字段
 *   min?: number,
 *   max?: number,
 *   defaultWidth?: number,             // 双击重置值
 * }} options
 * @returns {{ destroy: () => void }}
 */
export function createTocResizer({
  handle,
  getWidth,
  onPreview,
  onCommit,
  min = TOC_WIDTH_MIN,
  max = TOC_WIDTH_MAX,
  defaultWidth = TOC_WIDTH_DEFAULT,
} = {}) {
  const minWidth = Number.isFinite(Number(min)) ? Number(min) : TOC_WIDTH_MIN;
  const maxWidth = Number.isFinite(Number(max)) ? Number(max) : TOC_WIDTH_MAX;
  const resetWidth = Number.isFinite(Number(defaultWidth)) ? Number(defaultWidth) : TOC_WIDTH_DEFAULT;

  let drag = null; // { startX, startWidth, currentWidth }
  let destroyed = false;

  function clamp(value) {
    return clampWidth(value, minWidth, maxWidth);
  }

  /** 当前宽度：以 shell 设置状态为准（jsdom 无布局也不依赖 getBoundingClientRect）。 */
  function readWidth() {
    const raw = typeof getWidth === 'function' ? Number(getWidth()) : Number.NaN;
    return clamp(Number.isFinite(raw) ? raw : resetWidth);
  }

  /** 拖拽期间全局禁选中（CSS 负责 user-select/cursor），非浏览器环境静默跳过。 */
  function setResizing(active) {
    const body = globalThis.document && globalThis.document.body;
    if (!body || typeof body.classList !== 'object') {
      return;
    }
    body.classList.toggle(RESIZING_CLASS, active);
  }

  function preview(width) {
    if (typeof onPreview === 'function') {
      onPreview(width);
    }
  }

  function commit(width, startWidth) {
    if (typeof onCommit === 'function') {
      onCommit(width, startWidth);
    }
  }

  function detachDocumentListeners() {
    const doc = globalThis.document;
    if (!doc || typeof doc.removeEventListener !== 'function') {
      return;
    }
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerUp);
  }

  /** 结束拖拽：卸 document 监听、恢复选中；commit 为 true 时把最终宽按起始宽交给 shell 落盘。 */
  function finishDrag(shouldCommit) {
    if (!drag) {
      return;
    }
    const { startWidth, currentWidth } = drag;
    drag = null;
    detachDocumentListeners();
    setResizing(false);
    if (handle && handle.classList && typeof handle.classList.remove === 'function') {
      handle.classList.remove('dragging');
    }
    if (shouldCommit) {
      commit(currentWidth, startWidth);
    }
  }

  function onPointerDown(event) {
    if (destroyed || !handle || handle.hidden || drag) {
      return;
    }
    // 只响应主键（jsdom 的 new Event 没有 button 属性，此时不拦）
    if (event && typeof event.button === 'number' && event.button !== 0) {
      return;
    }
    const clientX = Number(event && event.clientX);
    if (!Number.isFinite(clientX)) {
      return;
    }
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const startWidth = readWidth();
    drag = { startX: clientX, startWidth, currentWidth: startWidth };
    if (handle.classList && typeof handle.classList.add === 'function') {
      handle.classList.add('dragging');
    }
    setResizing(true);
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('pointermove', onPointerMove);
      doc.addEventListener('pointerup', onPointerUp);
      doc.addEventListener('pointercancel', onPointerUp);
    }
  }

  function onPointerMove(event) {
    if (!drag || destroyed) {
      return;
    }
    const clientX = Number(event && event.clientX);
    if (!Number.isFinite(clientX)) {
      return;
    }
    const next = clamp(drag.startWidth + (clientX - drag.startX));
    if (next === drag.currentWidth) {
      return;
    }
    drag.currentWidth = next;
    preview(next);
  }

  function onPointerUp() {
    finishDrag(true);
  }

  function onDoubleClick(event) {
    if (destroyed) {
      return;
    }
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const startWidth = readWidth();
    const next = clamp(resetWidth);
    if (next === startWidth) {
      return; // 已经是默认宽：不产生无变化的 saveSettings
    }
    preview(next);
    commit(next, startWidth);
  }

  /** 键盘无障碍（可选增强）：左右方向键 ±10，行为与一次小拖拽一致。 */
  function onKeyDown(event) {
    if (destroyed || !event) {
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const startWidth = readWidth();
    const step = event.key === 'ArrowLeft' ? -RESIZER_KEYBOARD_STEP : RESIZER_KEYBOARD_STEP;
    const next = clamp(startWidth + step);
    if (next === startWidth) {
      return;
    }
    preview(next);
    commit(next, startWidth);
  }

  const canListen = Boolean(handle) && typeof handle.addEventListener === 'function';
  if (canListen) {
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', onDoubleClick);
    handle.addEventListener('keydown', onKeyDown);
  }

  return {
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      finishDrag(false);
      if (canListen) {
        handle.removeEventListener('pointerdown', onPointerDown);
        handle.removeEventListener('dblclick', onDoubleClick);
        handle.removeEventListener('keydown', onKeyDown);
      }
    },
  };
}
