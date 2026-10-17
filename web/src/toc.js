// TOC 侧栏（Task 10）：由渲染后 DOM 采集的标题列表生成大纲 nav，并做滚动联动高亮。
// buildToc 只产出结构（文本/href 全部用 DOM API 写入，绝不拼 HTML 字符串）；
// createScrollSpy 负责「滚动位置 → 当前标题」：scroll 事件经 requestAnimationFrame 节流，
// 索引变化时才回调（避免每次滚动都改 DOM）。点击跳转由 shell 装配（它持有滚动容器与工具条偏移）。
// 评审修复：标题 top 快照会因重排失效，shell 用 setHeadings 刷新；update() 不假定 top 严格升序
// （折叠 details / 图片占位后可能出现 offsetTop=0 的乱序标题），隐藏标题跳过。

import { cancelScheduledFrame, scheduleFrame } from './frame.js';

/** 跳转偏移：悬浮工具条高度占位（spec §5.3「目标标题带固定偏移，避免被工具条遮挡」）。 */
export const TOC_TOOLBAR_OFFSET = 80;

/** 滚动联动的默认阈值（与工具条偏移一致：标题顶部进入工具条下方即算当前标题）。 */
export const DEFAULT_THRESHOLD_PX = 80;

const MIN_LEVEL = 1;
const MAX_LEVEL = 6;

/** 标题层级：非 1–6 的整数一律按 1（与 [TOC] 内联目录的口径一致）。 */
function normalizeLevel(level) {
  const value = Number(level);
  return Number.isInteger(value) && value >= MIN_LEVEL && value <= MAX_LEVEL ? value : MIN_LEVEL;
}

/**
 * 由标题列表生成侧栏大纲（扁平 ol，层级用 li[data-level] 表达，CSS 负责缩进）。
 * 无标题时返回空 <nav class="toc"></nav>（不含 ol）。
 * @param {{id: string, text: string, level: number}[]} headings
 * @returns {HTMLElement} nav.toc
 */
export function buildToc(headings) {
  const doc = globalThis.document;
  const nav = doc.createElement('nav');
  nav.className = 'toc';
  const list = Array.isArray(headings) ? headings.filter((heading) => heading && typeof heading === 'object') : [];
  if (list.length === 0) {
    return nav;
  }

  const ol = doc.createElement('ol');
  for (const heading of list) {
    const li = doc.createElement('li');
    li.dataset.level = String(normalizeLevel(heading.level));
    const link = doc.createElement('a');
    link.setAttribute('href', `#${typeof heading.id === 'string' ? heading.id : ''}`);
    link.textContent = typeof heading.text === 'string' ? heading.text : String(heading.text ?? '');
    li.append(link);
    ol.append(li);
  }
  nav.append(ol);
  return nav;
}

/**
 * 滚动联动：监听 scroller 的 scroll（rAF 节流）并计算当前标题。
 * @param {{
 *   scroller: HTMLElement,
 *   headings: {id: string, text: string, level: number, top: number, hidden?: boolean}[],
 *   onActive?: (heading: object, index: number) => void,
 *   thresholdPx?: number,
 * }} options
 * @returns {{ update: () => void, setHeadings: (headings: object[]) => void, destroy: () => void }}
 */
export function createScrollSpy({ scroller, headings, onActive, thresholdPx = DEFAULT_THRESHOLD_PX } = {}) {
  let list = Array.isArray(headings) ? headings.filter((heading) => heading && typeof heading === 'object') : [];
  const scrollRoot = scroller && typeof scroller === 'object' ? scroller : null;
  const thresholdNumber = Number(thresholdPx);
  const threshold = Number.isFinite(thresholdNumber) ? thresholdNumber : DEFAULT_THRESHOLD_PX;

  let activeIndex = -1;
  let frame = null;
  let destroyed = false;

  /**
   * 当前标题：线性扫描取「top ≤ scrollTop + threshold 的最大 top」。
   * 不假定 top 严格升序——标题在折叠 details / 图片占位替换 / 字号变化后会重排，快照可能乱序，
   * 二分会在乱序数组上返回错误索引；n = 标题数，O(n) 完全可接受。
   * hidden === true（折叠 details 内等不可见标题，offsetTop 恒 0）跳过：不能让隐藏标题抢高亮。
   */
  function findIndex(scrollTop) {
    if (list.length === 0) {
      return -1;
    }
    const limit = scrollTop + threshold;
    let found = -1;
    let foundTop = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < list.length; i += 1) {
      const heading = list[i];
      if (!heading || heading.hidden === true) {
        continue;
      }
      const top = Number(heading.top);
      if (!Number.isFinite(top) || top > limit) {
        continue;
      }
      if (top >= foundTop) {
        found = i;
        foundTop = top;
      }
    }
    if (found >= 0) {
      return found;
    }
    // 文档顶部、首个可见标题尚未进入阈值时仍高亮第一项：阅读位置在大纲第一项之前，不能没有当前项。
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].hidden !== true) {
        return i;
      }
    }
    // 全部标题都被隐藏（极端：整篇都在闭合 details 里）：退回第一项，保持「总有当前项」的既有口径。
    return 0;
  }

  /** 同步计算一次当前标题；索引变化才回调。 */
  function update() {
    if (destroyed || !scrollRoot) {
      return;
    }
    const scrollTop = Number(scrollRoot.scrollTop);
    const index = findIndex(Number.isFinite(scrollTop) ? scrollTop : 0);
    if (index === activeIndex) {
      return;
    }
    activeIndex = index;
    const heading = index >= 0 ? list[index] : null;
    if (!heading || typeof onActive !== 'function') {
      return;
    }
    try {
      onActive(heading, index);
    } catch {
      // 回调异常不能中断滚动 / 渲染：高亮失效也不能影响阅读。
    }
  }

  function onScroll() {
    if (destroyed || frame !== null) {
      return;
    }
    frame = scheduleFrame(() => {
      frame = null;
      update();
    });
  }

  const canListen = Boolean(scrollRoot) && typeof scrollRoot.addEventListener === 'function';
  if (canListen) {
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
  }

  return {
    update,
    /**
     * 替换标题表（shell 在重排后刷新 top 时调用）：重置选中索引，下一次 update 会重新计算并按需回调。
     * 不清空标题表语义（无标题时传空数组等价于空文档）。destroy 后调用是空操作。
     */
    setHeadings(nextHeadings) {
      if (destroyed) {
        return;
      }
      list = Array.isArray(nextHeadings) ? nextHeadings.filter((heading) => heading && typeof heading === 'object') : [];
      activeIndex = -1;
    },
    destroy() {
      destroyed = true;
      cancelScheduledFrame(frame);
      frame = null;
      if (canListen) {
        scrollRoot.removeEventListener('scroll', onScroll, { passive: true });
      }
    },
  };
}

/** 供 shell 复用：读取渲染后标题元素的顶部偏移（jsdom 无布局时为 0，测试用桩注入）。 */
export function readHeadingTop(element) {
  if (!element) {
    return 0;
  }
  const top = Number(element.offsetTop);
  return Number.isFinite(top) ? top : 0;
}

/** 供 shell 复用：标题元素层级（h1–h6 → 1–6）。 */
export function readHeadingLevel(element) {
  if (!element || typeof element.tagName !== 'string') {
    return MIN_LEVEL;
  }
  return normalizeLevel(Number(element.tagName.charAt(1)));
}
