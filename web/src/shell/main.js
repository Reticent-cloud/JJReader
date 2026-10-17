// shell 总装：固定 DOM 骨架、消息分发、正文渲染与 renderDone 回报。
// 正文走 JJ.renderMarkdown（Task 5 起为 markdown-it 引擎），引擎缺失时降级 escapeHtml + <pre> 保证不白屏；
// TOC/主题/工具条等在 Task 10+ 继续往这里装配。

/** 全局唯一的时间源：优先高精度计时，缺失时退回 Date.now。 */
function now() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/** HTML 文本转义（仅引擎缺失时的兜底渲染用；正常正文由 renderMarkdown 输出，T7 统一加 DOMPurify 清洗）。 */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 文本的 UTF-8 字节数（renderDone.bytes 用；手写计数，不依赖 TextEncoder 是否存在）。 */
function utf8Length(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) {
    const codePoint = ch.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * 在 root（宿主页面的 #app）里装配 shell，返回 { root, onMessage }。
 * post(type, payload) 由调用方注入：浏览器环境走 window.chrome.webview.postMessage，
 * 测试传收集器。mountShell 完成后立即发一次 shellReady（宿主收到后才推送 load，
 * 避免 PostWebMessageAsJson 在页面监听器就绪前丢失）。
 */
export function mountShell({ root, post } = {}) {
  if (!root) {
    throw new Error('mountShell: 缺少 root 容器');
  }
  const send = typeof post === 'function' ? post : () => {};

  // 固定骨架：#app > header#toolbar、aside#toc、main#content（滚动容器）、div#toast
  root.replaceChildren();
  const toolbar = document.createElement('header');
  toolbar.id = 'toolbar';
  const toc = document.createElement('aside');
  toc.id = 'toc';
  const content = document.createElement('main');
  content.id = 'content';
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.hidden = true;
  root.append(toolbar, toc, content, toast);

  const state = {
    path: '',
    key: '',
    baseUrl: '',
    settings: {},
    position: null,
    assoc: null,
    dirListing: null,
  };

  /**
   * 正文渲染：优先走 JJ.renderMarkdown（与宿主共用同一 markdown-it 实现，baseUrl 用于解析相对图片）。
   * 引擎缺失（打包缺失/加载失败）时降级为 escapeHtml + <pre>，保证正文区永远不白屏。
   */
  function render(markdown) {
    const engine = globalThis.JJ;
    if (engine && typeof engine.renderMarkdown === 'function') {
      content.innerHTML = engine.renderMarkdown(markdown, { baseUrl: state.baseUrl });
      return;
    }
    content.innerHTML = `<pre class="jj-fallback">${escapeHtml(markdown)}</pre>`;
  }

  /** 标题数（renderDone.tocCount）：引擎缺失或返回值异常时按 0 上报，契约字段不能缺。 */
  function countHeadings(markdown) {
    const engine = globalThis.JJ;
    if (!engine || typeof engine.extractHeadings !== 'function') {
      return 0;
    }
    const headings = engine.extractHeadings(markdown);
    return Array.isArray(headings) ? headings.length : 0;
  }

  function renderLoad(payload) {
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
    state.path = typeof payload.path === 'string' ? payload.path : '';
    state.key = typeof payload.key === 'string' ? payload.key : '';
    state.baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl : '';
    state.settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    state.position = typeof payload.position === 'number' ? payload.position : null;

    const started = now();
    render(markdown);
    const tocCount = countHeadings(markdown);
    const elapsedMs = Math.max(0, now() - started);

    // 契约（spec §4.4）：renderDone{path, elapsedMs, tocCount, bytes}
    send('renderDone', {
      path: state.path,
      elapsedMs,
      tocCount,
      bytes: utf8Length(markdown),
    });
  }

  function showToast(text, level = 'info') {
    const item = document.createElement('div');
    item.className = 'toast';
    item.dataset.level = level;
    item.setAttribute('role', 'status');
    item.textContent = String(text ?? '');
    toast.hidden = false;
    toast.append(item);
  }

  /** 消息分发：load/toast/assocState/dirListing；未知 type 静默忽略（坏消息不能中断 shell）。 */
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

  // 握手：shell 装配完成 → 通知宿主可以推 load 了（只发一次）。
  send('shellReady', {});

  return { root, onMessage };
}
