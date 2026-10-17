window.__JJ_CSS_TEXT__ = "";
(() => {
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
    const api = { version: "0.1.0" };
    target.JJ = api;
    applyCss(globalThis.window?.__JJ_CSS_TEXT__);
    return api;
  }
  if (typeof window !== "undefined") {
    install(window);
  }
})();
