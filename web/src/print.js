// 打印模式（Task 15）：PDF 导出前给页面加 body.print-mode 并强制浅色，导出结束后恢复原主题。
// 只做 class/dataset 切换（不拼 HTML）；window.JJ 不存在或消息通道缺失时静默降级，绝不让导出流程抛异常。
// 退出函数幂等：重复调用/重复进入只恢复一次原主题，避免把「浅色」当成原主题留存。

/** 模块级活动打印状态：同一时间只有一份（页面只打印当前文档）。 */
let activePrintState = null;

/** 安全的日志输出（无 console 的环境直接忽略）。 */
function log(message) {
  try {
    if (globalThis.console && typeof globalThis.console.warn === 'function') {
      globalThis.console.warn(`[JJ] ${message}`);
    }
  } catch {
    // 日志失败不影响导出流程
  }
}

/**
 * 进入打印模式：记下当前 data-theme，给 body 加 print-mode，并强制 data-theme=light。
 * 重复调用返回同一个退出函数（不会把强制浅色当成「原主题」二次记录）。
 * @param {{document?: Document}} [options] document 注入（默认全局 document；测试用）
 * @returns {() => void} 退出打印模式（恢复原主题并移除 class；幂等）
 */
export function enterPrintMode({ document: doc } = {}) {
  const targetDoc = doc ?? globalThis.document;
  if (!targetDoc || !targetDoc.body) {
    return () => {};
  }

  if (activePrintState) {
    if (activePrintState.doc === targetDoc) {
      return activePrintState.exit;
    }
    // 页面只打印一个文档；换 document（测试/多文档容器）时先恢复上一份再进入
    activePrintState.exit();
  }

  const root = targetDoc.documentElement ?? null;
  const previousTheme = root && typeof root.getAttribute === 'function' ? root.getAttribute('data-theme') : null;

  // print.css 把 #content 改为 overflow:visible 后滚动位置会丢：进入前记下，退出时恢复（评审加固 4）。
  const content = typeof targetDoc.getElementById === 'function' ? targetDoc.getElementById('content') : null;
  const previousScrollTop = content ? Number(content.scrollTop) || 0 : 0;

  targetDoc.body.classList.add('print-mode');
  if (root) {
    root.dataset.theme = 'light';
  }

  const state = { doc: targetDoc, root, previousTheme, content, previousScrollTop, exit: null };
  const exit = () => {
    if (activePrintState !== state) {
      return;
    }
    activePrintState = null;
    state.doc.body.classList.remove('print-mode');
    if (state.root) {
      if (state.previousTheme === null) {
        state.root.removeAttribute('data-theme');
      } else {
        state.root.setAttribute('data-theme', state.previousTheme);
      }
    }
    if (state.content) {
      try {
        // class 已移除（overflow 恢复成滚动容器）后再写回导出前的滚动位置
        state.content.scrollTop = state.previousScrollTop;
      } catch {
        // 滚动容器已销毁/只读：恢复失败不影响主题与 class 的清理
      }
    }
  };
  state.exit = exit;
  activePrintState = state;
  return exit;
}

/**
 * 解析 readyToPrint 的发送通道：优先 mountShell 记下的 JJ.__post（与宿主同一 post 实现），
 * 其次 WebView2 的 chrome.webview.postMessage；都没有返回 null（调用方只打日志）。
 */
function resolvePrintPost() {
  const api = globalThis.JJ;
  if (api && typeof api.__post === 'function') {
    return (type, payload) => api.__post(type, payload);
  }

  const webview = globalThis.window && globalThis.window.chrome && globalThis.window.chrome.webview;
  if (webview && typeof webview.postMessage === 'function') {
    return (type, payload) => webview.postMessage({ type, payload });
  }

  return null;
}

/**
 * 导出前把分块懒渲染剩下的块同步渲染出来（shell 经 JJ.__ensureAllRendered 暴露：无分块/已全渲染时是空操作）。
 * 未装配 shell（函数缺失）或渲染异常都只跳过：导出宁可少内容也不能卡在 readyToPrint 之前。
 */
function ensureAllRendered() {
  const api = globalThis.JJ;
  if (!api || typeof api.__ensureAllRendered !== 'function') {
    return;
  }
  try {
    api.__ensureAllRendered();
  } catch {
    log('同步渲染全文失败，按当前已渲染内容导出');
  }
}

/**
 * 等待单张图片就绪：已 complete 的图片直接 decode；未完成的等 load/error 后再 decode。
 * decode 失败（图片解码不了）不算错误——打印继续，避免导出卡死。
 * @param {HTMLImageElement} image
 * @returns {Promise<void>}
 */
function waitForImage(image) {
  const decode = () => {
    if (typeof image.decode === 'function') {
      return image.decode().catch(() => {});
    }
    return Promise.resolve();
  };
  if (image.complete) {
    return Promise.resolve(decode());
  }
  return new Promise((resolve) => {
    const done = () => {
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
      resolve(decode());
    };
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
  });
}

/** 打印前资源等待上限（修复波 B-I3）：图片/字体等待合计最多 2 秒，超时继续导出。 */
export const PRINT_ASSET_WAIT_MS = 2000;

/**
 * 修复波 B-I3（PDF 导出可能漏掉 lazy 图片）：
 * 1. 所有 `img[loading=lazy]` 改为 eager（打印布局前先把图片纳入加载）；
 * 2. 等待图片 load/error + decode（未完成的图片最多等到整体 deadline）；
 * 3. 可选等待 document.fonts.ready（字体就绪后分页更准）；
 * 4. 强制一次 reflow，让打印样式下的布局在 PrintToPdf 前稳定。
 * 任何一步失败/超时都继续（导出宁可少等，也不能卡住 readyToPrint）。
 * @param {{document?: Document, timeoutMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function waitForPrintAssets({ document: doc = globalThis.document, timeoutMs = PRINT_ASSET_WAIT_MS } = {}) {
  if (!doc) {
    return;
  }
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : PRINT_ASSET_WAIT_MS;
  const deadline = Date.now() + limit;

  const images = typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('img')) : [];
  for (const image of images) {
    try {
      // 打印前不让浏览器继续延迟加载：lazy 图片可能根本没开始请求
      image.loading = 'eager';
    } catch {
      // 只读/不支持 loading 的环境忽略
    }
  }

  const remaining = () => Math.max(0, deadline - Date.now());
  if (images.length > 0) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, remaining());
    });
    try {
      await Promise.race([Promise.all(images.map((image) => waitForImage(image))), timeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  // 字体就绪（jsdom 无 document.fonts：直接跳过；超过剩余时间也继续）
  const fonts = doc.fonts;
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, remaining());
    });
    try {
      await Promise.race([fonts.ready.catch(() => {}), timeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  // 强制一次 reflow：把 print-mode 的布局/图片尺寸在调用 PrintToPdfAsync 前落定。
  try {
    const body = doc.body;
    if (body) {
      void body.offsetHeight;
    }
  } catch {
    // 无布局环境忽略
  }
}

/**
 * 宿主调用（ExecuteScriptAsync）：进入打印模式，保存退出函数到 window.__jjPrintExit，
 * 等图片/字体就绪后经消息通道回报 readyToPrint（宿主收到后才 PrintToPdfAsync）。任何一步失败都不抛。
 * 返回 Promise 便于测试等待；宿主 ExecuteScriptAsync 不依赖返回值。
 */
export async function enterPrintModeForPdf() {
  const win = globalThis.window ?? null;

  // 上一次导出残留的退出函数先收掉，保证 window.__jjPrintExit 只对应本次打印模式
  const previousExit = win ? win.__jjPrintExit : null;
  if (typeof previousExit === 'function') {
    try {
      previousExit();
    } catch {
      // 旧状态清理失败不影响本次进入
    }
  }

  // Task 15 修复：>512 KB 文档分块懒渲染，导出前必须先渲染全文，否则 PDF 只含已渲染块（spec §2.3）
  ensureAllRendered();

  const exit = enterPrintMode({ document: globalThis.document });
  if (win) {
    win.__jjPrintExit = exit;
  }

  const post = resolvePrintPost();
  if (!post) {
    log('消息通道不可用，无法发送 readyToPrint');
    return;
  }

  // 修复波 B-I3：先等图片（lazy → eager + decode）与字体，最多 2s；超时照常导出。
  try {
    await waitForPrintAssets({ document: globalThis.document });
  } catch {
    log('等待图片/字体就绪失败，按当前内容导出');
  }

  try {
    post('readyToPrint', {});
  } catch {
    log('发送 readyToPrint 失败');
  }
}

/**
 * 宿主调用（ExecuteScriptAsync）：退出打印模式并清空 window.__jjPrintExit。
 * 即使 __jjPrintExit 丢失（脚本环境异常），也会按模块内状态恢复界面。
 */
export function exitPrintModeForPdf() {
  const win = globalThis.window ?? null;
  const exit = win ? win.__jjPrintExit : null;
  if (win) {
    delete win.__jjPrintExit;
  }

  if (typeof exit === 'function') {
    try {
      exit();
    } catch {
      // 退出函数异常不能阻止后续兜底清理
    }
    return;
  }

  if (activePrintState) {
    try {
      activePrintState.exit();
    } catch {
      // 兜底清理失败只可能发生在 DOM 被销毁时，忽略
    }
  }
}

/**
 * 当前文档路径 → 建议的 PDF 文件名：取文件名（兼容 / 与 \ 分隔）去最后一个扩展名，加 .pdf。
 * @param {string} path 文档路径
 * @returns {string} 例如 D:\资料\中文 笔记.md → 中文 笔记.pdf
 */
export function pdfSuggestedFileName(path) {
  const text = typeof path === 'string' ? path : '';
  const base = text.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem || '导出'}.pdf`;
}
