// 鲸鲸阅读器前端引擎入口：装配 engine/shell 并暴露 window.JJ（后续任务往 install 的 API 上逐个加成员）。
// 当前成员：version、mountShell、renderMarkdown、extractHeadings、slugify（标题锚点 id 生成）、
// extractFrontmatter（front matter 解析，T8）、highlight（代码高亮）、enhance（渲染后增强：复制按钮/外链）、
// sanitizeHtml（T7 清洗出口）；Task 10 起加 TOC 侧栏（buildToc/createScrollSpy）、
// 主题（applyTheme）、排版（applySettings/settingsPatch）与 applyCss（T4 carry-forward：CSS 注入共用）；
// Task 11 起加大文档分块（splitBlocks/createChunkedRenderer/阈值常量/isHuge）。
// 浏览器（WebView2）环境自动装配 shell 并建立双向消息通道。
import {
  CHUNK_THRESHOLD,
  createChunkedRenderer,
  HUGE_THRESHOLD,
  INITIAL_BYTES,
  isHuge,
  MAX_BLOCK_BYTES,
  splitBlocks,
} from './chunk.js';
import { extractFrontmatter, extractHeadings, renderMarkdown, slugify } from './engine.js';
import { enhance } from './enhance.js';
import { highlight } from './highlight.js';
import { sanitizeHtml } from './sanitize.js';
import { applySettings, settingsPatch } from './settings.js';
import { mountShell } from './shell/main.js';
import { applyTheme } from './theme.js';
import { buildToc, createScrollSpy } from './toc.js';

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

// 前端 API 的唯一出口：测试在 setup.js 里 install(globalThis)，浏览器里 install(window)。
export function install(target = {}) {
  const api = {
    version: '0.1.0',
    mountShell,
    renderMarkdown,
    extractHeadings,
    extractFrontmatter,
    slugify,
    highlight,
    enhance,
    sanitizeHtml,
    // Task 10：TOC 侧栏与滚动联动、主题三态、排版调节
    buildToc,
    createScrollSpy,
    applyTheme,
    applySettings,
    settingsPatch,
    // Task 11：大文档分块渲染与大文件模式
    CHUNK_THRESHOLD,
    INITIAL_BYTES,
    MAX_BLOCK_BYTES,
    HUGE_THRESHOLD,
    splitBlocks,
    isHuge,
    createChunkedRenderer,
    // T4 carry-forward：CSS 注入与 shell 共用同一实现（浏览器 boot 时已调用一次）
    applyCss,
  };
  target.JJ = api;
  applyCss(globalThis.window?.__JJ_CSS_TEXT__);
  return api;
}

// 浏览器（WebView2）环境：DOM ready 后自动 mountShell 并注册消息监听。
// jsdom / 单测环境没有 window.chrome.webview，不会自动 mount（用例显式调用 JJ.mountShell）。
function bootWebViewShell() {
  const webview = globalThis.window?.chrome?.webview;
  if (!webview) {
    return;
  }

  const start = () => {
    const root = document.getElementById('app');
    if (!root) {
      return;
    }
    const shell = mountShell({
      root,
      post: (type, payload) => webview.postMessage({ type, payload }),
    });
    // mountShell 内部已发出 shellReady；监听器在同一个同步任务里注册完成，
    // 宿主的 load 只会在收到 shellReady 之后推送，因此这一小段先后顺序不会丢消息。
    webview.addEventListener('message', (event) => shell.onMessage(event.data));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

if (typeof window !== 'undefined') {
  install(window);
  bootWebViewShell();
}
