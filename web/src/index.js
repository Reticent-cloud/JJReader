// 鲸鲸阅读器前端引擎入口。Task 1 只提供最小 install 骨架，后续任务在此扩展。

const STYLE_ATTR = 'data-jj';

// 把构建期内联的 CSS 文本写入 <head> 下的 <style data-jj>。
// 幂等：重复调用复用同一元素，只更新内容；空文本或非浏览器环境直接跳过。
export function applyCss(cssText) {
  if (!cssText) {
    return;
  }
  const doc = globalThis.document;
  if (!doc || !doc.head) {
    return;
  }
  let style = doc.head.querySelector(`style[${STYLE_ATTR}]`);
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute(STYLE_ATTR, '');
    doc.head.appendChild(style);
  }
  if (style.textContent !== cssText) {
    style.textContent = cssText;
  }
}

export function install(target = {}) {
  const api = { version: '0.1.0' };
  target.JJ = api;
  applyCss(globalThis.window?.__JJ_CSS_TEXT__);
  return api;
}

if (typeof window !== 'undefined') {
  install(window);
}
