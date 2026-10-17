// 阅读 chrome（Task 12）：位置追踪、阅读进度条 / 回到顶部、toast。
// 位置：滚动节流 500ms 上报（比例 = scrollTop / max(1, scrollHeight - clientHeight)，夹紧 [0,1]），
// 关闭/隐藏页面时强制 flush；进度条（spec §5.1 右侧 3px 竖向条）高度与回到顶部显隐按 400px 阈值随滚动更新。
// toast：3 秒自动消失，可带一个可点击 action（「已回到上次位置 · 回到顶部」用）。

/** 位置上报节流（Global Constraints：500ms）。 */
export const POSITION_THROTTLE_MS = 500;

/** 回到顶部按钮显隐阈值（Global Constraints：滚离顶部 > 400px）。 */
export const BACK_TO_TOP_THRESHOLD_PX = 400;

/** toast 默认显示时长（spec §5.6：3 秒后消失）。 */
export const TOAST_DURATION_MS = 3000;

/** 滚动度量（jsdom 无布局时 Number() 可能得到 NaN，一律兜底 0）。 */
function readScrollMetrics(scroller) {
  if (!scroller || typeof scroller !== 'object') {
    return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  }
  const scrollTop = Number(scroller.scrollTop);
  const scrollHeight = Number(scroller.scrollHeight);
  const clientHeight = Number(scroller.clientHeight);
  return {
    scrollTop: Number.isFinite(scrollTop) ? scrollTop : 0,
    scrollHeight: Number.isFinite(scrollHeight) ? scrollHeight : 0,
    clientHeight: Number.isFinite(clientHeight) ? clientHeight : 0,
  };
}

function clampRatio(ratio) {
  return Math.min(1, Math.max(0, ratio));
}

/**
 * 分块文档的全文高度估算（T12 评审 Important 1）：分块模式首屏只渲染了前缀，
 * 用「已渲染高度 / 已渲染字节」的密度把未渲染字节外推成高度，避免用首屏高度当分母。
 *
 *   estimatedTotal = renderedHeight + (renderedHeight / renderedBytes) × (totalBytes - renderedBytes)
 *
 * @param {number} renderedHeight 当前已渲染内容的 scrollHeight（px）
 * @param {number} renderedBytes 已渲染块累计的源码 UTF-8 字节数
 * @param {number} totalBytes 全文 UTF-8 字节数
 * @returns {number} 估算的全文高度（px）；没有可用的字节基准或已全部渲染时返回已渲染高度
 */
export function estimateTotalHeight(renderedHeight, renderedBytes, totalBytes) {
  const height = Number(renderedHeight);
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
  if (safeHeight === 0) {
    return 0;
  }
  const rendered = Number(renderedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(rendered) || !Number.isFinite(total) || rendered <= 0) {
    return safeHeight;
  }
  const remainingBytes = Math.max(0, total - rendered);
  if (remainingBytes === 0) {
    return safeHeight;
  }
  return safeHeight + (safeHeight / rendered) * remainingBytes;
}

/** 滚动比例：分母用 max(1, scrollHeight - clientHeight) 兜底不可滚动/无布局的容器。 */
function readScrollRatio(scroller) {
  const { scrollTop, scrollHeight, clientHeight } = readScrollMetrics(scroller);
  return { ratio: clampRatio(scrollTop / Math.max(1, scrollHeight - clientHeight)), scrollTop };
}

/**
 * 位置追踪器：scroll 事件节流节流上报，比例变化才发；flush() 立即发（同比例也发）。
 * 另监听 pagehide / visibilitychange(hidden) 时 flush，保证关窗前位置不丢。
 *
 * 分块模式（Important 1）：传 readChunkBytes 时，未全部渲染的比例按估算的全文高度计算：
 *   ratio = scrollTop / max(1, estimateTotalHeight(scrollHeight, renderedBytes, totalBytes) - clientHeight)
 * readChunkBytes 返回 null（普通文档 / 分块已全部渲染）时退回真实 scrollHeight。
 * @param {{
 *   scroller: HTMLElement,
 *   key: string,
 *   emit: (key: string, ratio: number) => void,
 *   throttleMs?: number,
 *   readChunkBytes?: (() => {renderedBytes: number, totalBytes: number} | null) | null,
 *   estimateTotalHeight?: (renderedHeight: number, renderedBytes: number, totalBytes: number) => number,
 * }} options
 * @returns {{start: () => void, flush: () => void, destroy: () => void}}
 */
export function createPositionTracker({
  scroller,
  key,
  emit,
  throttleMs = POSITION_THROTTLE_MS,
  readChunkBytes = null,
  estimateTotalHeight: estimateFn = estimateTotalHeight,
} = {}) {
  const scrollRoot = scroller && typeof scroller === 'object' ? scroller : null;
  const emitRatio = typeof emit === 'function' ? emit : null;
  const throttleNumber = Number(throttleMs);
  const throttle = Number.isFinite(throttleNumber) ? Math.max(0, throttleNumber) : POSITION_THROTTLE_MS;

  let timer = null;
  let started = false;
  let destroyed = false;
  let lastRatio = null;

  /** 当前位置比例：分块未全部渲染时按估算全文高度，否则用真实可滚动高度。 */
  function readRatio() {
    if (typeof readChunkBytes === 'function' && typeof estimateFn === 'function') {
      let bytes = null;
      try {
        bytes = readChunkBytes();
      } catch {
        bytes = null; // 估算数据不可用：退回真实高度，不能因为上报失败丢位置
      }
      const renderedBytes = Number(bytes && bytes.renderedBytes);
      const totalBytes = Number(bytes && bytes.totalBytes);
      if (bytes && Number.isFinite(renderedBytes) && Number.isFinite(totalBytes)) {
        const { scrollTop, scrollHeight, clientHeight } = readScrollMetrics(scrollRoot);
        const estimated = estimateFn(scrollHeight, renderedBytes, totalBytes);
        return clampRatio(scrollTop / Math.max(1, estimated - clientHeight));
      }
    }
    return readScrollRatio(scrollRoot).ratio;
  }

  /** 上报一次：force=false 时比例与上次相同则跳过。 */
  function emitNow(force) {
    const ratio = readRatio();
    if (!force && ratio === lastRatio) {
      return;
    }
    lastRatio = ratio;
    if (emitRatio) {
      try {
        emitRatio(key, ratio);
      } catch {
        // 上报失败（宿主消息通道关闭）不能中断滚动
      }
    }
  }

  function schedule() {
    if (timer !== null || destroyed) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      emitNow(false);
    }, throttle);
  }

  function onScroll() {
    schedule();
  }

  function onPageHide() {
    flush();
  }

  function onVisibilityChange() {
    const doc = globalThis.document;
    if (doc && doc.visibilityState === 'hidden') {
      flush();
    }
  }

  /** 立即上报当前位置（取消待执行的节流定时器；同比例也发）。 */
  function flush() {
    if (destroyed) {
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    emitNow(true);
  }

  /** 绑定 scroll / pagehide / visibilitychange（幂等）。 */
  function start() {
    if (started || destroyed || !scrollRoot) {
      return;
    }
    started = true;
    if (typeof scrollRoot.addEventListener === 'function') {
      scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    }
    const win = globalThis.window;
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', onPageHide);
    }
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  /** 解绑全部监听并取消待执行的节流定时器（destroy 后 flush 是空操作）。 */
  function destroy() {
    destroyed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (started) {
      if (scrollRoot && typeof scrollRoot.removeEventListener === 'function') {
        scrollRoot.removeEventListener('scroll', onScroll, { passive: true });
      }
      const win = globalThis.window;
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('pagehide', onPageHide);
      }
      const doc = globalThis.document;
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
    }
    started = false;
  }

  return { start, flush, destroy };
}

// back-to-top 的 click 绑定（WeakMap 保证重复 updateChrome 不会重复绑定；换 scroller 时换绑）。
const backToTopBindings = new WeakMap();

function bindBackToTop(backToTopEl, scroller) {
  if (!backToTopEl || typeof backToTopEl.addEventListener !== 'function') {
    return;
  }
  const previous = backToTopBindings.get(backToTopEl);
  if (previous && previous.scroller === scroller) {
    return;
  }
  if (previous) {
    backToTopEl.removeEventListener('click', previous.handler);
  }
  const handler = () => {
    if (scroller && typeof scroller.scrollTo === 'function') {
      try {
        scroller.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      } catch {
        // scrollTo 在极老环境/桩里可能抛错：退回直接写 scrollTop
      }
    }
    if (scroller) {
      scroller.scrollTop = 0;
    }
  };
  backToTopEl.addEventListener('click', handler);
  backToTopBindings.set(backToTopEl, { scroller, handler });
}

/**
 * 更新阅读 chrome：竖向进度条高度 = 滚动比例（CSS height %）；scrollTop > thresholdPx 时显示回到顶部；
 * 点击回到顶部平滑滚到顶部（同一元素/容器只绑定一次）。
 * @param {{scroller: HTMLElement, progressEl?: HTMLElement, backToTopEl?: HTMLElement, thresholdPx?: number}} options
 */
export function updateChrome({ scroller, progressEl, backToTopEl, thresholdPx = BACK_TO_TOP_THRESHOLD_PX } = {}) {
  const scrollRoot = scroller && typeof scroller === 'object' ? scroller : null;
  const { ratio, scrollTop } = readScrollRatio(scrollRoot);
  if (progressEl && progressEl.style) {
    progressEl.style.height = `${(ratio * 100).toFixed(2)}%`;
  }
  // 无障碍（T12 原报告 §10.6 carry-forward）：外层 [role=progressbar] 的 aria-valuenow 同步百分比
  const bar = progressEl && progressEl.parentElement ? progressEl.parentElement : null;
  if (bar && typeof bar.setAttribute === 'function' && bar.getAttribute('role') === 'progressbar') {
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  const thresholdNumber = Number(thresholdPx);
  const threshold = Number.isFinite(thresholdNumber) ? thresholdNumber : BACK_TO_TOP_THRESHOLD_PX;
  if (backToTopEl) {
    backToTopEl.hidden = !(scrollTop > threshold);
    bindBackToTop(backToTopEl, scrollRoot);
  }
}

/** 阅读 chrome 的骨架元素：右侧 3px 竖向进度条（内层 #progress-bar 由 updateChrome 写高度）+ 回到顶部按钮。 */
export function createChromeElements() {
  const progress = document.createElement('div');
  progress.id = 'progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '阅读进度');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', '0');

  const progressEl = document.createElement('div');
  progressEl.id = 'progress-bar';
  progress.append(progressEl);

  const backToTopEl = document.createElement('button');
  backToTopEl.type = 'button';
  backToTopEl.id = 'back-to-top';
  backToTopEl.hidden = true;
  backToTopEl.textContent = '回到顶部';
  backToTopEl.title = '回到顶部';

  return { progress, progressEl, backToTopEl };
}

// toast 容器：mountShell 装配时登记；未装配（单测直接调 JJ.showToast）时回退到 document 里的 #toast 或自建。
let activeToastContainer = null;

/** mountShell 登记自己的 #toast 容器（避免多实例/document.getElementById 歧义）。 */
export function setToastContainer(element) {
  activeToastContainer = element ?? null;
}

/** destroy 时解除登记（只清自己，避免误清另一个已装配的 shell）。 */
export function clearToastContainer(element) {
  if (activeToastContainer === element) {
    activeToastContainer = null;
  }
}

function resolveToastContainer() {
  const doc = globalThis.document;
  if (activeToastContainer && activeToastContainer.isConnected !== false) {
    return activeToastContainer;
  }
  let container = doc.getElementById('toast');
  if (!container) {
    container = doc.createElement('div');
    container.id = 'toast';
    container.hidden = true;
    doc.body.append(container);
  }
  return container;
}

/**
 * 显示一条 toast：默认 3 秒自动消失；actionText 存在时追加一个可点击按钮，点击后执行 onAction 并立即消失。
 * @param {string} text
 * @param {string} [level] info / warn / error（写 data-level 供 CSS 配色）
 * @param {{durationMs?: number, actionText?: string, onAction?: () => void}} [options]
 */
export function showToast(text, level = 'info', { durationMs = TOAST_DURATION_MS, actionText, onAction } = {}) {
  const doc = globalThis.document;
  if (!doc) {
    return;
  }
  const container = resolveToastContainer();
  const item = doc.createElement('div');
  item.className = 'toast';
  item.dataset.level = typeof level === 'string' && level !== '' ? level : 'info';
  item.setAttribute('role', 'status');

  const label = doc.createElement('span');
  label.className = 'toast-text';
  label.textContent = String(text ?? '');
  item.append(label);

  let timer = null;
  const dismiss = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    item.remove();
    if (container.querySelectorAll('.toast').length === 0) {
      container.hidden = true;
    }
  };

  if (typeof actionText === 'string' && actionText !== '') {
    const action = doc.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionText;
    action.addEventListener('click', () => {
      dismiss();
      if (typeof onAction === 'function') {
        try {
          onAction();
        } catch {
          // 动作失败不能把 toast 留在屏幕上
        }
      }
    });
    item.append(action);
  }

  container.hidden = false;
  container.append(item);

  const duration = Number(durationMs);
  if (Number.isFinite(duration) && duration > 0) {
    timer = setTimeout(dismiss, duration);
  }
}
