// 鲸鲸阅读器前端引擎入口：装配 engine/shell 并暴露 window.JJ（后续任务往 install 的 API 上逐个加成员）。
// 当前成员：version、mountShell、renderMarkdown、extractHeadings、slugify（标题锚点 id 生成）、
// extractFrontmatter（front matter 解析，T8）、highlight（代码高亮）、enhance（渲染后增强：复制按钮/外链）、
// sanitizeHtml（T7 清洗出口）；Task 10 起加 TOC 侧栏（buildToc/createScrollSpy）、
// 主题（applyTheme）、排版（applySettings/settingsPatch）与 applyCss（T4 carry-forward：CSS 注入共用）；
// Task 11 起加大文档分块（splitBlocks/createChunkedRenderer/阈值常量/isHuge）；
// Task 12 起加最近文件面板（renderRecent）、位置追踪（createPositionTracker）、阅读 chrome（updateChrome）与 toast；
// Task 14 起加文件树侧栏（renderTree/setSidebarMode/applyDirListing/setTreeActive）；
// Task 15 起加打印模式（enterPrintMode / enterPrintModeForPdf / exitPrintModeForPdf，供 PDF 导出）。
// 浏览器（WebView2）环境自动装配 shell 并建立双向消息通道。
import {
  appendLinkDefinitions,
  CHUNK_THRESHOLD,
  createChunkedRenderer,
  extractLinkDefinitions,
  HUGE_THRESHOLD,
  INITIAL_BYTES,
  isHuge,
  MAX_BLOCK_BYTES,
  splitBlocks,
  utf8Length,
} from './chunk.js';
import { extractFrontmatter, extractHeadings, renderMarkdown, slugify } from './engine.js';
import { enhance } from './enhance.js';
import { highlight } from './highlight.js';
import { enterPrintMode, enterPrintModeForPdf, exitPrintModeForPdf } from './print.js';
import { sanitizeHtml } from './sanitize.js';
import { applySettings, settingsPatch } from './settings.js';
import { createPositionTracker, estimateTotalHeight, showToast, updateChrome } from './shell/chrome.js';
import { mountShell } from './shell/main.js';
import { renderRecent } from './shell/recent.js';
import { applyDirListing, renderTree, setSidebarMode, setTreeActive } from './shell/tree.js';
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
    // Task 11 修复：UTF-8 字节口径（阈值判断与 renderDone.bytes 同源）与跨块引用式链接定义补齐
    utf8Length,
    extractLinkDefinitions,
    appendLinkDefinitions,
    // Task 12：最近文件面板、位置追踪、阅读 chrome（进度条/回到顶部）与可点击 toast
    renderRecent,
    createPositionTracker,
    updateChrome,
    showToast,
    // Task 12 评审修复：分块文档位置比例的全文高度估算（Important 1）
    estimateTotalHeight,
    // Task 14：文件树侧栏（渲染 / 侧栏模式 / dirListing 填充 / 当前文件高亮）
    renderTree,
    setSidebarMode,
    applyDirListing,
    setTreeActive,
    // Task 15：PDF 导出打印模式（宿主经 ExecuteScriptAsync 调用；测试直接调用）
    enterPrintMode,
    enterPrintModeForPdf,
    exitPrintModeForPdf,
    // T4 carry-forward：CSS 注入与 shell 共用同一实现（浏览器 boot 时已调用一次）
    applyCss,
  };
  target.JJ = api;
  applyCss(globalThis.window?.__JJ_CSS_TEXT__);
  return api;
}

/**
 * WebView2 消息监听的安全入口（修复波 B-§5.11）：单条坏消息/渲染异常不能让监听器抛异常
 * （异常会冒泡到 WebView 宿主事件，表现成「界面卡住」）。宿主消息是外部输入，严格按数据对待。
 * @param {{onMessage?: (message: any) => void}} shell mountShell 的返回值
 * @param {unknown} data event.data
 */
export function dispatchWebMessage(shell, data) {
  if (!shell || typeof shell.onMessage !== 'function') {
    return;
  }
  try {
    shell.onMessage(data);
  } catch (error) {
    try {
      console.warn('[JJ] 消息监听失败，已忽略该消息', error);
    } catch {
      // 无 console 环境忽略
    }
  }
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
    webview.addEventListener('message', (event) => dispatchWebMessage(shell, event.data));
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
