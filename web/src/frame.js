// 共享帧调度（Task 10 评审修复）：把「滚动位置 / 标题位置」这类重算合并到下一帧，
// 避免拖拽、图片异步加载、排版变化连续触发时逐次重排（抖动）。
// 无 requestAnimationFrame 的环境（老旧 WebView / 测试桩）退回 16ms 定时器，保证节流语义一致。

/**
 * 调度一次帧回调。
 * @param {() => void} callback
 * @returns {{ type: 'raf' | 'timeout', id: number }} 句柄，交给 cancelScheduledFrame 取消
 */
export function scheduleFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return { type: 'raf', id: globalThis.requestAnimationFrame(callback) };
  }
  return { type: 'timeout', id: setTimeout(callback, 16) };
}

/**
 * 取消尚未执行的帧回调（幂等：null / undefined 直接忽略）。
 * @param {{ type: 'raf' | 'timeout', id: number } | null} frame
 */
export function cancelScheduledFrame(frame) {
  if (!frame) {
    return;
  }
  if (frame.type === 'raf') {
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(frame.id);
    }
    return;
  }
  clearTimeout(frame.id);
}
