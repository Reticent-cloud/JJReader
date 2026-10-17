// 正文渲染管线（Task 12 从 main.js 拆出，行为不变）：
// 引擎缺失兜底 → front matter 属性块 → 一次性/分块渲染 → 大文件模式 → 渲染后增强。
// 设计约束（T8/T9/T11 carry-forward）：
//   - 每次渲染传新的 env 字面量（env 会被写入 frontmatter，复用会串文档）；
//   - 分块渲染全文只 extractHeadings 一次，每块只对新增节点做标题 id 增量配对与 enhance（避免 O(n²)）；
//   - 引用式链接定义全文预抽取后逐块追加（定义不产生输出，解决文末定义跨块失效）；
//   - 大文件模式关闭高亮、停用滚动联动；分块失败退回一次性渲染，引擎缺失降级 escapeHtml + <pre>，绝不白屏。

import { appendLinkDefinitions, extractLinkDefinitions, utf8Length } from '../chunk.js';
import { collectExtracted, collectHeadingsFromNodes } from './headings.js';

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

/**
 * front matter「属性」折叠块（Task 9）：先用 JJ.extractFrontmatter 取本文档属性数据
 * （T8 carry-forward：不复用 renderMarkdown 写回的 env，避免跨文档陈旧），非空时在 #content 顶部插入
 * <details class="frontmatter"><summary>属性</summary><table>…</table></details>（默认折叠）。
 * 表格用 createElement/textContent 逐格写入：属性值是不可信文本，绝不拼 HTML 字符串。
 */
function mountFrontmatter(content, markdown) {
  const engine = globalThis.JJ;
  if (!engine || typeof engine.extractFrontmatter !== 'function') {
    return;
  }
  const result = engine.extractFrontmatter(markdown);
  const data = result && typeof result === 'object' ? result.data : null;
  if (!data || typeof data !== 'object') {
    return;
  }
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return;
  }

  const details = document.createElement('details');
  details.className = 'frontmatter';
  const summary = document.createElement('summary');
  summary.textContent = '属性';
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const [key, value] of entries) {
    const row = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = String(key);
    const td = document.createElement('td');
    // 数组值用「、」连接；布尔/数字统一按字符串展示（与 extractFrontmatter 的解析口径一致）
    td.textContent = Array.isArray(value)
      ? value.map((item) => String(item)).join('、')
      : String(value);
    row.append(th, td);
    tbody.append(row);
  }
  table.append(tbody);
  details.append(summary, table);
  content.prepend(details);
}

/**
 * 文档渲染器：main.js 只负责消息/状态，这里负责把 markdown 渲染进 #content。
 * @param {{
 *   content: HTMLElement,
 *   getState: () => {baseUrl: string, huge: boolean, chunked: any},
 *   tocController: object,
 *   send: (type: string, payload?: object) => void,
 *   showToast: (text: string, level?: string, options?: object) => void,
 * }} options
 */
export function createRenderer({ content, getState, tocController, send, showToast } = {}) {
  const state = () => getState();

  /** 渲染后增强（幂等；增强失败不能让已经显示出来的正文消失）。 */
  function enhanceContent() {
    const engine = globalThis.JJ;
    if (!engine || typeof engine.enhance !== 'function') {
      return;
    }
    try {
      engine.enhance(content, { baseUrl: state().baseUrl });
    } catch {
      // 增强失败（复制按钮/图片占位）不能影响已经渲染好的正文
    }
  }

  /** 只增强本次新增的顶层节点（幂等；评审 #3：不再每块重扫整个 #content）。 */
  function enhanceNodes(nodes) {
    const engine = globalThis.JJ;
    if (!engine || typeof engine.enhance !== 'function') {
      return;
    }
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || node.nodeType !== 1) {
        continue;
      }
      try {
        engine.enhance(node, { baseUrl: state().baseUrl });
      } catch {
        // 单块增强失败（复制按钮/图片占位）不能影响已经渲染好的正文
      }
    }
  }

  /** 拆掉上一次的分块渲染器（断开哨兵观察器）；下次 load 前先调用，避免观察器泄漏到新文档。 */
  function clearChunked() {
    if (!state().chunked) {
      return;
    }
    try {
      state().chunked.destroy();
    } catch {
      // 断开失败不影响新文档渲染
    }
    state().chunked = null;
  }

  /**
   * 大文件模式开关（Task 11）：body.huge-mode 供 CSS 关闭高亮视觉；spyEnabled=false 停用滚动联动。
   * 进入时发送 toast（宿主 post + 本地提示各一次），切回普通文档时必须移除 class，否则普通文档也停在高亮关闭样式。
   */
  function applyHugeMode(huge) {
    state().huge = huge;
    tocController.setSpyEnabled(!huge);
    if (!huge) {
      document.body.classList.remove('huge-mode');
      return;
    }
    document.body.classList.add('huge-mode');
    send('toast', { text: '大文件模式：已关闭代码高亮', level: 'warn' });
    showToast('大文件模式：已关闭代码高亮', 'warn');
  }

  /**
   * 一次性渲染（普通文档，或分块渲染失败时的兜底）：
   * innerHTML → front matter 属性块 → 标题 id 兜底 + 建 TOC → enhance。
   */
  function renderSingle(markdown, huge, engine) {
    content.innerHTML = engine.renderMarkdown(markdown, {
      baseUrl: state().baseUrl,
      disableHighlight: huge,
    });
    mountFrontmatter(content, markdown);
    const extracted = collectExtracted(markdown);
    const headings = tocController.assignIds(extracted);
    tocController.renderToc(headings);
    enhanceContent();
    return headings;
  }

  /**
   * 分块渲染（Task 11 大文档）：全文只 extractHeadings 一次；首屏只渲染预算内块，其余由哨兵懒加载。
   * 每追加一块：首块挂 front matter 属性块 → 只对**新增节点**做标题 id 增量配对与 enhance → 同步新 top。
   * 评审 #2：全文预抽取引用式链接定义，每块渲染前追加（定义不产生输出，解决文末定义跨块失效）。
   * 评审 #3：每块操作 O(新块)——不再对整个容器重跑标题分配/enhance。
   * TOC 基于全文标题；未渲染标题的 top 记为 Infinity（滚动联动跳过），渲染后回填真实位置。
   */
  function renderChunked(markdown, huge, engine) {
    const split = engine.splitBlocks(markdown);
    const blocks = split && Array.isArray(split.blocks) ? split.blocks : [];
    if (blocks.length === 0) {
      return renderSingle(markdown, huge, engine);
    }
    const extracted = collectExtracted(markdown);
    tocController.setExtractedCount(extracted.length);
    const tocHeadings = extracted.map((heading) => ({
      ...heading,
      top: Number.POSITIVE_INFINITY,
      hidden: false,
    }));

    content.replaceChildren();
    tocController.renderToc(tocHeadings);
    // 评审 #2：分块独立 parse 时文末定义对前面块不可见——全文预抽取后逐块追加（块内已有同名定义不重复）
    const linkDefinitions = extractLinkDefinitions(markdown);
    // 评审 #3：标题 id 配对改为增量（全局 id 集合 + 全文标题游标），每块只处理新节点
    const assigner = tocController.createAssigner(extracted);

    let frontmatterMounted = false;
    const initialBytes = Number.isFinite(engine.INITIAL_BYTES) ? engine.INITIAL_BYTES : undefined;
    try {
      const renderer = engine.createChunkedRenderer({
        container: content,
        blocks,
        initialBytes,
        observerRoot: content,
        render: (blockText) => {
          const source = appendLinkDefinitions(blockText, linkDefinitions);
          return engine.renderMarkdown(source, {
            baseUrl: state().baseUrl,
            // 大文件模式关闭高亮：围栏只输出转义纯文本，省掉 highlight.js 的首屏开销
            disableHighlight: huge,
            // T9 carry-forward：分块后 [TOC] 仍要列出全文标题（不是只列当前块）
            tocHeadings: extracted,
          });
        },
        onChunkRendered: (info) => {
          if (!frontmatterMounted) {
            frontmatterMounted = true;
            mountFrontmatter(content, markdown);
          }
          const nodes = info && Array.isArray(info.nodes) ? info.nodes : [];
          // 只配对/增强新块：标题 id 与全文 extractHeadings 顺序一致且唯一
          const newHeadings = assigner.assign(collectHeadingsFromNodes(nodes));
          if (newHeadings.length > 0) {
            tocController.applyTops(newHeadings);
          }
          enhanceNodes(nodes);
          tocController.syncSpy();
        },
      });
      state().chunked = renderer;
      renderer.start();
    } catch {
      // 分块渲染失败绝不白屏：拆掉半成品退回一次性渲染
      clearChunked();
      content.replaceChildren();
      return renderSingle(markdown, huge, engine);
    }
    return tocController.getHeadings();
  }

  /**
   * 正文渲染入口：优先走 JJ.renderMarkdown（与宿主共用同一 markdown-it 实现，baseUrl 用于解析相对图片）。
   * 每次渲染都传新的 env 字面量（T8 carry-forward：env 会被写入 frontmatter，复用会串文档）。
   * Task 11 起按大小切换策略：> CHUNK_THRESHOLD 或 isHuge → 分块（首屏 INITIAL_BYTES，huge 关高亮/停联动）；
   * 否则保持原一次性渲染。引擎缺失（打包缺失/加载失败）时降级为 escapeHtml + <pre>，保证正文区永远不白屏。
   * @returns {{id: string, text: string, level: number, top: number}[]} 渲染后 DOM 的标题列表
   */
  function render(markdown) {
    const engine = globalThis.JJ;
    if (!engine || typeof engine.renderMarkdown !== 'function') {
      clearChunked();
      applyHugeMode(false);
      content.innerHTML = `<pre class="jj-fallback">${escapeHtml(markdown)}</pre>`;
      tocController.setExtractedCount(0);
      tocController.renderToc([]);
      return [];
    }

    clearChunked();
    const huge = typeof engine.isHuge === 'function' && engine.isHuge(markdown) === true;
    applyHugeMode(huge);

    const threshold = Number.isFinite(engine.CHUNK_THRESHOLD) ? engine.CHUNK_THRESHOLD : 512 * 1024;
    const canChunk =
      typeof engine.splitBlocks === 'function' && typeof engine.createChunkedRenderer === 'function';
    // 阈值与 renderDone.bytes 同源：按 UTF-8 字节，不能用 UTF-16 length（中文文档会被低估 1/3）
    if (canChunk && markdown.length > 0 && (huge || utf8Length(markdown) > threshold)) {
      return renderChunked(markdown, huge, engine);
    }
    return renderSingle(markdown, huge, engine);
  }

  return { render, clearChunked };
}
