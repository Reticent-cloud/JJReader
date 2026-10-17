// 阅读 chrome（Task 12）：位置追踪、阅读进度条 / 回到顶部、toast。
// 位置：滚动节流 500ms 上报（比例 = scrollTop / max(1, scrollHeight - clientHeight)，夹紧 [0,1]），
// 关闭/隐藏页面时强制 flush；进度条宽度与回到顶部显隐按 400px 阈值随滚动更新。
// toast：3 秒自动消失，可带一个可点击 action（「已回到上次位置 · 回到顶部」用）。

/** 位置上报节流（Global Constraints：500ms）。 */
export const POSITION_THROTTLE_MS = 500;

/** 回到顶部按钮显隐阈值（Global Constraints：滚离顶部 > 400px）。 */
export const BACK_TO_TOP_THRESHOLD_PX = 400;

/** toast 默认显示时长（spec §5.6：3 秒后消失）。 */
export const TOAST_DURATION_MS = 3000;

/** 滚动比例：分母用 max(1, scrollHeight - clientHeight) 兜底不可滚动/无布局的容器。 */
function readScrollRatio(scroller) {
  if (!scroller || typeof scroller !== 'object') {
    return { ratio: 0, scrollTop: 0 };
  }
  const scrollTop = Number(scroller.scrollTop);
  const scrollHeight = Number(scroller.scrollHeight);
  const clientHeight = Number(scroller.clientHeight);
  const safeTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const scrollable = Math.max(
    1,
    (Number.isFinite(scrollHeight) ? scrollHeight : 0) - (Number.isFinite(clientHeight) ? clientHeight : 0),
  );
  return { ratio: Math.min(1, Math.max(0, safeTop / scrollable)), scrollTop: safeTop };
}

/**
 * 位置追踪器：scroll 事件节流节流上报，比例变化才发；flush() 立即发（同比例也发）。
 * 另监听 pagehide / visibilitychange(hidden) 时 flush，保证关窗前位置不丢。
 * @param {{scroller: HTMLElement, key: string, emit: (key: string, ratio: number) => void, throttleMs?: number}} options
 * @returns {{start: () => void, flush: () => void, destroy: () => void}}
 */
export function createPositionTracker({ scroller, key, emit, throttleMs = POSITION_THROTTLE_MS } = {}) {
  const scrollRoot = scroller && typeof scroller === 'object' ? scroller : null;
  const emitRatio = typeof emit === 'function' ? emit : null;
  const throttleNumber = Number(throttleMs);
  const throttle = Number.isFinite(throttleNumber) ? Math.max(0, throttleNumber) : POSITION_THROTTLE_MS;

  let timer = null;
  let started = false;
  let destroyed = false;
  let lastRatio = null;

  /** 上报一次：force=false 时比例与上次相同则跳过。 */
  function emitNow(force) {
    const { ratio } = readScrollRatio(scrollRoot);
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
 * 更新阅读 chrome：进度条宽度 = 滚动比例（CSS width %）；scrollTop > thresholdPx 时显示回到顶部；
 * 点击回到顶部平滑滚到顶部（同一元素/容器只绑定一次）。
 * @param {{scroller: HTMLElement, progressEl?: HTMLElement, backToTopEl?: HTMLElement, thresholdPx?: number}} options
 */
export function updateChrome({ scroller, progressEl, backToTopEl, thresholdPx = BACK_TO_TOP_THRESHOLD_PX } = {}) {
  const scrollRoot = scroller && typeof scroller === 'object' ? scroller : null;
  const { ratio, scrollTop } = readScrollRatio(scrollRoot);
  if (progressEl && progressEl.style) {
    progressEl.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  const thresholdNumber = Number(thresholdPx);
  const threshold = Number.isFinite(thresholdNumber) ? thresholdNumber : BACK_TO_TOP_THRESHOLD_PX;
  if (backToTopEl) {
    backToTopEl.hidden = !(scrollTop > threshold);
    bindBackToTop(backToTopEl, scrollRoot);
  }
}

/** 阅读 chrome 的骨架元素：顶部 3px 进度条（内层 #progress-bar 由 updateChrome 写宽度）+ 回到顶部按钮。 */
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
