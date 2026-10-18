// 设置落盘防抖（Task 12 评审修复 Minor b；修复波 E 补 pagehide/visibilitychange flush）。
// 背景：Aa 面板滑杆每触发一次 input 就 post('saveSettings') 会让宿主反复 LoadSettings + 原子写。
// 口径：拖动期间只 apply（main.js 负责即时写 CSS 变量），这里把 patch 累积起来，停手 300ms 后只发一次；
// 关面板/离开面板/快捷键等非拖动路径调用方先 flush() 或直接 save(patch, {defer:false})，
// 后者会把累积的滑杆 patch 合并进本次消息一起发——避免 pending 里的旧值稍后覆盖新值。
// 关窗/切后台：与位置追踪（chrome.js 的 createPositionTracker）同口径监听 pagehide / visibilitychange(hidden)，
// 立即 flush，保证折叠/关窗前的最后一次拖动不丢；destroy() 解绑并补发 pending。

/** 滑杆落盘防抖延迟：300ms（无新输入才算停手）。 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 300;

/**
 * 创建一个设置落盘器。
 * @param {{send: (type: string, payload?: object) => void, delayMs?: number}} options
 * @returns {{save: (patch: object, options?: {defer?: boolean}) => void, flush: () => void, destroy: () => void}}
 */
export function createSettingsSaver({ send, delayMs = SETTINGS_SAVE_DEBOUNCE_MS } = {}) {
  const post = typeof send === 'function' ? send : () => {};
  const delayNumber = Number(delayMs);
  const delay = Number.isFinite(delayNumber) ? Math.max(0, delayNumber) : SETTINGS_SAVE_DEBOUNCE_MS;

  let pending = null;
  let timer = null;
  let destroyed = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function emit(patch) {
    if (patch && Object.keys(patch).length > 0) {
      post('saveSettings', { patch });
    }
  }

  /** 立即发出累积的 patch（无 pending 时什么都不做）。 */
  function flush() {
    if (destroyed) {
      return;
    }
    clearTimer();
    const patch = pending;
    pending = null;
    emit(patch);
  }

  /**
   * 记录一次设置变化并落盘：
   * defer=true 只累积并重置 300ms 定时器（滑杆拖动中）；否则与累积 patch 合并后立即发一条。
   * @param {object} patch 本次变化的字段（只含变化字段）
   * @param {{defer?: boolean}} [options]
   */
  function save(patch, { defer = false } = {}) {
    if (destroyed) {
      return;
    }
    const changed = patch && typeof patch === 'object' ? patch : {};
    if (Object.keys(changed).length === 0) {
      return;
    }
    if (defer) {
      pending = { ...(pending || {}), ...changed };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        const accumulated = pending;
        pending = null;
        emit(accumulated);
      }, delay);
      return;
    }
    const outgoing = { ...(pending || {}), ...changed };
    clearTimer();
    pending = null;
    emit(outgoing);
  }

  // 关窗/切后台 flush：定时器在页面隐藏后可能不再触发，最后一次拖动必须立即落盘。
  const win = globalThis.window ?? null;
  const doc = globalThis.document ?? (win && win.document ? win.document : null);

  function onPageHide() {
    flush();
  }

  function onVisibilityChange() {
    if (doc && doc.visibilityState === 'hidden') {
      flush();
    }
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('pagehide', onPageHide);
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  /** 解绑页面事件并补发 pending（shell destroy 时调用；重复调用幂等）。 */
  function destroy() {
    if (destroyed) {
      return;
    }
    flush();
    destroyed = true;
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('pagehide', onPageHide);
    }
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
  }

  return { save, flush, destroy };
}
