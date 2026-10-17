window.__JJ_CSS_TEXT__ = "";
(() => {
  // src/shell/main.js
  function now() {
    const perf = globalThis.performance;
    return perf && typeof perf.now === "function" ? perf.now() : Date.now();
  }
  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }
  function utf8Length(text) {
    let bytes = 0;
    for (const ch of String(text ?? "")) {
      const codePoint = ch.codePointAt(0);
      bytes += codePoint <= 127 ? 1 : codePoint <= 2047 ? 2 : codePoint <= 65535 ? 3 : 4;
    }
    return bytes;
  }
  function mountShell({ root, post } = {}) {
    if (!root) {
      throw new Error("mountShell: \u7F3A\u5C11 root \u5BB9\u5668");
    }
    const send = typeof post === "function" ? post : () => {
    };
    root.replaceChildren();
    const toolbar = document.createElement("header");
    toolbar.id = "toolbar";
    const toc = document.createElement("aside");
    toc.id = "toc";
    const content = document.createElement("main");
    content.id = "content";
    const toast = document.createElement("div");
    toast.id = "toast";
    toast.hidden = true;
    root.append(toolbar, toc, content, toast);
    const state = {
      path: "",
      key: "",
      baseUrl: "",
      settings: {},
      position: null,
      assoc: null,
      dirListing: null
    };
    function render(markdown) {
      content.innerHTML = `<pre class="jj-fallback">${escapeHtml(markdown)}</pre>`;
    }
    function renderLoad(payload) {
      const markdown = typeof payload.markdown === "string" ? payload.markdown : "";
      state.path = typeof payload.path === "string" ? payload.path : "";
      state.key = typeof payload.key === "string" ? payload.key : "";
      state.baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
      state.settings = payload.settings && typeof payload.settings === "object" ? payload.settings : {};
      state.position = typeof payload.position === "number" ? payload.position : null;
      const started = now();
      render(markdown);
      const elapsedMs = Math.max(0, now() - started);
      send("renderDone", {
        path: state.path,
        elapsedMs,
        tocCount: 0,
        bytes: utf8Length(markdown)
      });
    }
    function showToast(text, level = "info") {
      const item = document.createElement("div");
      item.className = "toast";
      item.dataset.level = level;
      item.setAttribute("role", "status");
      item.textContent = String(text ?? "");
      toast.hidden = false;
      toast.append(item);
    }
    function onMessage(message) {
      if (!message || typeof message !== "object") {
        return;
      }
      const type = typeof message.type === "string" ? message.type : "";
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      switch (type) {
        case "load":
          renderLoad(payload);
          break;
        case "toast":
          showToast(payload.text, payload.level);
          break;
        case "assocState":
          state.assoc = { registered: Boolean(payload.registered), isDefault: Boolean(payload.isDefault) };
          break;
        case "dirListing":
          state.dirListing = payload;
          break;
        default:
          break;
      }
    }
    send("shellReady", {});
    return { root, onMessage };
  }

  // src/index.js
  var STYLE_ATTR = "data-jj";
  function applyCss(cssText) {
    if (!cssText) {
      return;
    }
    const doc = globalThis.document;
    if (!doc || !doc.head) {
      return;
    }
    let style = doc.head.querySelector(`style[${STYLE_ATTR}]`);
    if (!style) {
      style = doc.createElement("style");
      style.setAttribute(STYLE_ATTR, "");
      doc.head.appendChild(style);
    }
    if (style.textContent !== cssText) {
      style.textContent = cssText;
    }
  }
  function install(target = {}) {
    const api = { version: "0.1.0", mountShell };
    target.JJ = api;
    applyCss(globalThis.window?.__JJ_CSS_TEXT__);
    return api;
  }
  function bootWebViewShell() {
    const webview = globalThis.window?.chrome?.webview;
    if (!webview) {
      return;
    }
    const start = () => {
      const root = document.getElementById("app");
      if (!root) {
        return;
      }
      const shell = mountShell({
        root,
        post: (type, payload) => webview.postMessage({ type, payload })
      });
      webview.addEventListener("message", (event) => shell.onMessage(event.data));
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
  if (typeof window !== "undefined") {
    install(window);
    bootWebViewShell();
  }
})();
