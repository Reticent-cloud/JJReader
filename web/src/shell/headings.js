// 标题 id 分配 + 标题位置快照刷新 + TOC 侧栏/滚动联动（Task 12 从 main.js 拆出，行为不变）。
// 设计约束：
//   - 标题 id 必须按 extractHeadings 顺序重赋（DOMPurify 会剥掉与 DOM 同名的 id，T7/T9 carry-forward）；
//   - 分块渲染用增量 assigner（只处理新块，避免 O(n²)）；一次性渲染用全文扫描版；
//   - 标题 top 快照只采集一次，字号/行距/行宽变化、侧栏拖宽、图片加载、窗口尺寸变化后由 shell 调
//     refresh()/scheduleRefresh() 重采集；点击 TOC 另外实时读元素位置（双保险）。
// TOC 点击与 `[TOC]` 内联目录点击共用 scrollToHeading（评审 #1：两处入口不各写一套）。

import { cancelScheduledFrame, scheduleFrame } from '../frame.js';
import { buildToc, createScrollSpy, readHeadingLevel, readHeadingTop, TOC_TOOLBAR_OFFSET } from '../toc.js';

/** 正文标题选择器：全文扫描与分块增量配对共用同一口径。 */
export const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/**
 * 标题是否不可见（在闭合的 <details> / hidden 容器里）。
 * 这类标题的 offsetTop / offsetHeight 都是 0：既不能参与滚动高亮（会与首标题抢），
 * 也不能按位置排序（破坏 top 单调性）。真实浏览器与 jsdom 口径一致（只看结构，不看布局）。
 */
export function isHeadingHidden(element) {
  if (!element || typeof element.closest !== 'function') {
    return false;
  }
  return element.closest('details:not([open])') !== null || element.closest('[hidden]') !== null;
}

/** 取全局 slugify（标题 id 兜底生成用）；引擎缺失时为 null。 */
function readSlugify() {
  const engine = globalThis.JJ;
  return engine && typeof engine.slugify === 'function' ? engine.slugify : null;
}

/**
 * 创建标题 id 分配器（Task 10 兜底口径 + Task 11 增量）：
 * 维护「全文标题游标 + 已定稿 id 集合」，每次 assign(elements) 只处理传入的元素——
 * 分块渲染每块成本 O(新块)，不再每块重扫整个 #content（评审 #3：避免 O(n²) 冻结）。
 * 配对口径不变：按 DOM 顺序 + 文本匹配（原始 HTML 标题不在 extractHeadings 里，不能按索引硬配）；
 * 实在配不上（纯标点标题等空 slug）时生成 section-N 兜底 id。重复 id 视为缺失重新配对：
 * 分块渲染时每块独立 parse，同名标题在不同块里会拿到相同 id，必须在这里改成全文唯一的 id。
 * @param {{id: string, text: string, level: number}[]} extracted 全文标题列表（全文只 parse 一次）
 * @param {{reservedIds?: Iterable<string>, slugify?: Function | null}} [options]
 *   reservedIds：一次性渲染时先登记容器里已有的 id（避免兜底 slug / 游标配对撞车）；
 *   分块增量路径不登记——新块的原始 id 交给游标重配对，跨块重复在 kept 里检测。
 * @returns {{assign: (elements: Iterable<Element>) => {id: string, text: string, level: number, top: number, hidden: boolean}[]}}
 */
export function createHeadingAssigner(extracted, { reservedIds, slugify } = {}) {
  const fullHeadings = Array.isArray(extracted) ? extracted : [];
  const slugifyFn = typeof slugify === 'function' ? slugify : readSlugify();
  const reserved = new Set();
  for (const id of reservedIds ?? []) {
    if (id) {
      reserved.add(id);
    }
  }
  // 已定稿的 id（分块渲染跨块累积）；再遇到同一个 id 说明是重复，按「缺失」重新配对，
  // 保证 TOC 链接（#id-2）能定位到元素。
  const kept = new Set();
  let cursor = 0;
  let assignedCount = 0;

  function fallbackId() {
    let suffix = assignedCount + 1;
    let candidate = `section-${suffix}`;
    while (reserved.has(candidate) || kept.has(candidate)) {
      suffix += 1;
      candidate = `section-${suffix}`;
    }
    return candidate;
  }

  function assign(elements) {
    const headings = [];
    for (const element of elements) {
      const text = (element.textContent || '').trim();
      let id = element.id;
      if (id && kept.has(id)) {
        // 重复 id：清掉后走下面「缺失 id」的配对分支，重新分配全文唯一 id
        id = '';
        element.removeAttribute('id');
      }
      if (id) {
        // 已有 id：把 extractHeadings 游标推进到同名项之后，保持顺序配对（原始 HTML 标题会自然跳过）
        for (let i = cursor; i < fullHeadings.length; i += 1) {
          const candidate = fullHeadings[i];
          if (candidate && typeof candidate === 'object' && candidate.id === id) {
            cursor = i + 1;
            break;
          }
        }
      } else {
        // 缺失 id：按顺序找文本一致、id 非空且未被占用的提取项（title/body 等被清洗剥掉的情形）
        let matched = -1;
        for (let i = cursor; i < fullHeadings.length; i += 1) {
          const candidate = fullHeadings[i];
          if (!candidate || typeof candidate !== 'object') {
            continue;
          }
          if (
            typeof candidate.id === 'string' &&
            candidate.id !== '' &&
            !kept.has(candidate.id) &&
            !reserved.has(candidate.id) &&
            String(candidate.text ?? '').trim() === text
          ) {
            matched = i;
            break;
          }
        }
        if (matched >= 0) {
          id = fullHeadings[matched].id;
          cursor = matched + 1;
        } else if (slugifyFn) {
          id = slugifyFn(text, new Set([...reserved, ...kept])) || fallbackId();
        } else {
          id = fallbackId();
        }
        element.id = id;
      }
      kept.add(id);
      assignedCount += 1;
      headings.push({
        id,
        text,
        level: readHeadingLevel(element),
        top: readHeadingTop(element),
        hidden: isHeadingHidden(element),
      });
    }
    return headings;
  }

  return { assign };
}

/** 对全文提取标题（分块渲染也只在开始时调用一次；块内渲染只做 id 兜底，不再重复解析全文）。 */
export function collectExtracted(markdown, engine = globalThis.JJ) {
  if (engine && typeof engine.extractHeadings === 'function') {
    const parsed = engine.extractHeadings(markdown);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  return [];
}

/**
 * 从新增顶层节点里按 DOM 顺序收集标题元素（分块增量配对的输入：不再扫整个 #content）。
 * 块渲染的根元素本身可能就是标题（块以 `## 标题` 开头时），因此根元素也要 matches 一次。
 */
export function collectHeadingsFromNodes(nodes) {
  const elements = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.nodeType !== 1) {
      continue;
    }
    if (typeof node.matches === 'function' && node.matches(HEADING_SELECTOR)) {
      elements.push(node);
    }
    if (typeof node.querySelectorAll === 'function') {
      elements.push(...node.querySelectorAll(HEADING_SELECTOR));
    }
  }
  return elements;
}

/**
 * TOC/标题状态控制器：持有 headings / spy / 当前高亮链接，向 shell 暴露
 * assignIds/createAssigner/renderToc/refresh/scheduleRefresh/applyTops/syncSpy/scrollToHeading 等。
 * @param {{content: HTMLElement, toc: HTMLElement}} options
 */
export function createTocController({ content, toc } = {}) {
  const state = {
    headings: [],
    headingById: new Map(),
    spy: null,
    activeLink: null,
    // 全文标题数（renderDone.tocCount 复用，避免为统计再多 parse 一次）
    extractedCount: 0,
    // Task 11：大文件模式停用滚动联动（TOC 仍生成）
    spyEnabled: true,
  };

  let refreshFrame = null;
  let destroyed = false;

  /** 全文扫描版（一次性渲染 / 分块兜底路径）：登记容器里已有 id → 按顺序配对全部标题。 */
  function assignIds(extracted) {
    const elements = content.querySelectorAll(HEADING_SELECTOR);
    state.extractedCount = Array.isArray(extracted) ? extracted.length : 0;
    const reservedIds = [];
    for (const element of elements) {
      if (element.id) {
        reservedIds.push(element.id);
      }
    }
    return createHeadingAssigner(extracted, { reservedIds }).assign(elements);
  }

  /** 采集标题元素相对 #content 的实时位置（保持 id/text/level，只更新 top 与 hidden）。 */
  function collectHeadingTops() {
    const byId = new Map();
    for (const element of content.querySelectorAll(HEADING_SELECTOR)) {
      if (element.id) {
        byId.set(element.id, element);
      }
    }
    for (const heading of state.headings) {
      const element = byId.get(heading.id) || null;
      if (!element) {
        continue;
      }
      heading.top = readHeadingTop(element);
      heading.hidden = isHeadingHidden(element);
    }
    return state.headings;
  }

  /** 重建滚动联动：旧实例必须先 destroy，避免 scroll 监听泄漏（spy 无 setHeadings 时的兜底路径也走这里）。 */
  function rebuildSpy(headings) {
    if (state.spy) {
      state.spy.destroy();
      state.spy = null;
    }
    if (!Array.isArray(headings) || headings.length === 0) {
      return;
    }
    state.spy = createScrollSpy({
      scroller: content,
      headings,
      onActive: (heading) => highlightToc(heading),
      thresholdPx: TOC_TOOLBAR_OFFSET,
    });
    state.spy.update();
  }

  /** 重排后刷新标题位置：更新快照并让滚动联动按新位置重算高亮（不重建 DOM，不闪）。 */
  function refresh() {
    if (destroyed || !state.spy || state.headings.length === 0) {
      return;
    }
    const headings = collectHeadingTops();
    if (typeof state.spy.setHeadings === 'function') {
      state.spy.setHeadings(headings);
      state.spy.update();
      return;
    }
    rebuildSpy(headings);
  }

  /** 把这次新增标题的实时 top/hidden 写回 TOC 数据（按 id 对应；未进全文标题表的原始 HTML 标题不影响 TOC）。 */
  function applyTops(headings) {
    for (const heading of headings) {
      const entry = state.headingById.get(heading.id);
      if (entry) {
        entry.top = heading.top;
        entry.hidden = heading.hidden;
      }
    }
  }

  /** 分块增量渲染后的滚动联动同步：对象共享，只把新增 top 交给 spy（不重扫全文）。 */
  function syncSpy() {
    if (!state.spy || state.headings.length === 0) {
      return;
    }
    if (typeof state.spy.setHeadings === 'function') {
      state.spy.setHeadings(state.headings);
      state.spy.update();
      return;
    }
    rebuildSpy(collectHeadingTops());
  }

  /** 把刷新合并到下一帧：拖拽/图片/排版变化会连续触发，逐次采集会造成抖动。 */
  function scheduleRefresh() {
    if (destroyed || refreshFrame !== null) {
      return;
    }
    refreshFrame = scheduleFrame(() => {
      refreshFrame = null;
      refresh();
    });
  }

  /** 高亮 TOC 中当前标题的链接（aria-current 同步，供键盘/读屏识别）。 */
  function highlightToc(heading) {
    const links = toc.querySelectorAll('nav.toc a');
    let current = null;
    for (const link of links) {
      if (link.getAttribute('href') === `#${heading.id}`) {
        current = link;
        break;
      }
    }
    if (!current) {
      return;
    }
    if (state.activeLink && state.activeLink !== current) {
      state.activeLink.classList.remove('active');
      state.activeLink.removeAttribute('aria-current');
    }
    current.classList.add('active');
    current.setAttribute('aria-current', 'true');
    state.activeLink = current;
  }

  /**
   * 重建 TOC 与滚动联动（无标题时显示空态提示，不创建 spy）。
   * Task 11：大文件模式（spyEnabled === false）只生成 TOC，不启用滚动联动。
   */
  function renderToc(headings) {
    state.headings = headings;
    state.headingById = new Map(
      (Array.isArray(headings) ? headings : [])
        .filter((heading) => heading && typeof heading === 'object' && typeof heading.id === 'string')
        .map((heading) => [heading.id, heading]),
    );
    state.activeLink = null;
    if (state.spy) {
      state.spy.destroy();
      state.spy = null;
    }
    toc.replaceChildren(buildToc(headings));
    if (headings.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'toc-empty';
      empty.textContent = '此文档没有标题';
      toc.append(empty);
      return;
    }
    if (state.spyEnabled) {
      rebuildSpy(headings);
    }
  }

  /** 按 id 找正文里的标题元素（只认 #content 内的元素，避免页面其它同名 id 干扰）。 */
  function findHeadingElement(id) {
    if (!id) {
      return null;
    }
    const element = document.getElementById(id);
    return element && content.contains(element) ? element : null;
  }

  /**
   * 滚动到指定标题（侧栏 TOC 与 `[TOC]` 内联目录共用）。
   * 位置以元素**实时** offsetTop 为准（快照可能因重排过期：即使某次刷新漏了时机也不会跳错），
   * 找不到元素时才退回标题快照 heading.top。
   * Task 11：分块模式下目标所在块可能还没渲染——由 shell 通过 shouldRenderAll 判断并 renderAll，
   * 这里随后刷新快照、重试定位；renderAll 后仍找不到（id 被清洗换名等）才回退快照，
   * 快照也无效（未渲染标题的 Infinity）则不滚错位置。
   * @param {string} id
   * @param {{shouldRenderAll?: (element: Element | null) => boolean, renderAll?: () => void}} [options]
   * @returns {boolean} 是否找到可滚动的位置
   */
  function scrollToHeading(id, { shouldRenderAll, renderAll } = {}) {
    if (!id) {
      return false;
    }
    let element = findHeadingElement(id);
    if (typeof shouldRenderAll === 'function' && shouldRenderAll(element)) {
      if (typeof renderAll === 'function') {
        try {
          renderAll();
        } catch {
          // 渲染剩余块失败时保留已渲染内容，下面按快照尽力定位
        }
      }
      // 新块的标题 id/enhance 已由 onChunkRendered 增量处理；这里刷新一次标题 top 让快照可用
      refresh();
      element = findHeadingElement(id);
    }

    const heading = state.headings.find((item) => item.id === id);
    if (!heading && !element) {
      return false;
    }
    const baseTop = element ? readHeadingTop(element) : heading.top;
    if (!Number.isFinite(baseTop)) {
      return false; // 目标仍未渲染且没有可用位置：宁可不动，也不滚到错误位置
    }
    const top = baseTop - TOC_TOOLBAR_OFFSET;
    if (typeof content.scrollTo === 'function') {
      content.scrollTo({ top, behavior: 'smooth' });
    } else {
      content.scrollTop = top;
    }
    return true;
  }

  /** 侧栏 TOC 点击：阻止默认跳转，复用 scrollToHeading（分块模式目标未渲染时先 renderAll）。 */
  function handleTocClick(event, options) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const link = target.closest('a[href^="#"]');
    if (!link || !toc.contains(link)) {
      return;
    }
    event.preventDefault();
    scrollToHeading((link.getAttribute('href') || '').slice(1), options);
  }

  /**
   * 正文内 `[TOC]` 内联目录点击（评审 #1）：只接管 nav.toc-inline 内的锚点链接；脚注回跳等其它站内锚点
   * 保持浏览器默认行为；分块模式下目标未渲染时先 renderAll 再实时定位。
   */
  function handleInlineTocClick(event, options) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const link = target.closest('a[href^="#"]');
    if (!link || !content.contains(link) || !link.closest('nav.toc-inline')) {
      return;
    }
    event.preventDefault();
    scrollToHeading((link.getAttribute('href') || '').slice(1), options);
  }

  return {
    assignIds,
    createAssigner: (extracted) => createHeadingAssigner(extracted),
    renderToc,
    refresh,
    scheduleRefresh,
    applyTops,
    syncSpy,
    scrollToHeading,
    handleTocClick,
    handleInlineTocClick,
    getHeadings: () => state.headings,
    getExtractedCount: () => state.extractedCount,
    setExtractedCount: (count) => {
      state.extractedCount = Number.isFinite(Number(count)) ? Number(count) : 0;
    },
    setSpyEnabled: (enabled) => {
      state.spyEnabled = Boolean(enabled);
    },
    isSpyEnabled: () => state.spyEnabled,
    destroy() {
      destroyed = true;
      cancelScheduledFrame(refreshFrame);
      refreshFrame = null;
      if (state.spy) {
        state.spy.destroy();
        state.spy = null;
      }
    },
  };
}
