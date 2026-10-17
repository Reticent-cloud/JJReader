// 鲸鲸阅读器大文档分块（Task 11）：切块算法 + 渐进渲染器 + 大文件阈值。
// 设计约束（与 Controller 决策一致）：
//   - 切块零丢失：blocks.join('') === markdown；
//   - 围栏代码块（``` / ~~~ 开头）与连续表格行是原子结构，块边界绝不落在其中；
//   - 块边界优先落在标题行（^#{1,6}\s）之前，其次空行段落，最后普通行边界；
//   - 首屏预算按「渲染出的 HTML UTF-8 字节数」计（真正的首屏 DOM/布局成本），首块无条件渲染（不空屏）；
//   - 懒加载观察器可注入（jsdom 无 IntersectionObserver，测试用 observerFactory 桩；生产用全局实现）。
// 安全口径：createChunkedRenderer 只把 render(blockText) 的返回值插入容器，render 由调用方提供
// （shell 传 JJ.renderMarkdown，出口已过 DOMPurify）；本模块不拼任何不可信 HTML。

/** 超过这个字节数走分块渲染（brief：512 KB）。 */
export const CHUNK_THRESHOLD = 512 * 1024;
/** 首屏渲染预算：累计渲染 HTML 字节数不超过该值（brief：256 KB）。 */
export const INITIAL_BYTES = 256 * 1024;
/** 单块上限（结构性原子块——超长围栏/表格——允许超出）（brief：64 KB）。 */
export const MAX_BLOCK_BYTES = 64 * 1024;
/** 大文件模式阈值：关闭代码高亮、不启用滚动联动（brief：20 MB）。 */
export const HUGE_THRESHOLD = 20 * 1024 * 1024;

/** 标题行：按 brief 口径 `^#{1,6}\s`。 */
const HEADING_RE = /^#{1,6}\s/;
/** 表格行：行首（允许缩进）为 `|`。 */
const TABLE_RE = /^\s*\|/;
/** 空行（含只有空白的行）。 */
const BLANK_RE = /^\s*$/;
/** 围栏起始行：最多 3 个前导空格 + 3 个以上 ` 或 ~。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Setext 标题的下划线行：切在它前面会把标题文字与下划线拆开。 */
const SETEXT_RE = /^ {0,3}(?:=+|-+)\s*$/;
/** 懒加载哨兵的 class（CSS 只需给它 1px 高度即可被观察）。 */
export const SENTINEL_CLASS = 'chunk-sentinel';
/** 哨兵提前触发距离：接近视口底部就渲染下一块，滚动更顺。 */
const OBSERVER_ROOT_MARGIN = '800px 0px';

/**
 * 文本的 UTF-8 字节数（与 shell 的 renderDone.bytes 口径一致）。
 * 以 UTF-16 长度为基础按码元修正：ASCII +0、两字节 +1、三字节 +2、代理对合计 +2。
 */
export function utf8Length(text) {
  const value = String(text ?? '');
  let bytes = value.length;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      continue;
    }
    if (code < 0x800) {
      bytes += 1;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 2; // 高代理：与随后的低代理合计 4 字节
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      continue; // 低代理：字节数已由高代理补齐
    } else {
      bytes += 2;
    }
  }
  return bytes;
}

/** 切成「保留行尾换行」的行数组（join('') 能逐字节还原原文）。 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * 逐行分析结构：围栏深度、表格行、空行、标题行、setext 下划线。
 * fenceBefore/fenceAfter 是「该行之前/之后是否在围栏内」，用于判断块边界是否落在围栏外。
 */
function analyzeLines(lines) {
  const n = lines.length;
  const fenceBefore = new Uint8Array(n);
  const fenceAfter = new Uint8Array(n);
  const table = new Uint8Array(n);
  const blank = new Uint8Array(n);
  const heading = new Uint8Array(n);
  const setext = new Uint8Array(n);

  let open = null; // { symbol: '`' | '~', length: number }
  let closeRe = null;

  for (let i = 0; i < n; i += 1) {
    const line = lines[i];
    fenceBefore[i] = open ? 1 : 0;
    if (!open) {
      const match = FENCE_OPEN_RE.exec(line);
      if (match) {
        const marker = match[1];
        open = { symbol: marker.charAt(0), length: marker.length };
        closeRe = new RegExp(`^ {0,3}${open.symbol === '`' ? '`' : '~'}{${open.length},}\\s*$`);
      }
    } else if (closeRe && closeRe.test(line)) {
      open = null;
      closeRe = null;
    }
    fenceAfter[i] = open ? 1 : 0;

    const inFence = fenceBefore[i] === 1 || fenceAfter[i] === 1;
    blank[i] = BLANK_RE.test(line) ? 1 : 0;
    table[i] = !inFence && TABLE_RE.test(line) ? 1 : 0;
    heading[i] = fenceBefore[i] === 0 && HEADING_RE.test(line) ? 1 : 0;
    setext[i] = !inFence && SETEXT_RE.test(line) ? 1 : 0;
  }

  return { n, fenceBefore, fenceAfter, table, blank, heading, setext };
}

/** 能否在第 p 行之前切块：不在围栏内、不拆表格、不拆 setext 标题。 */
function isSafeBefore(p, info) {
  if (p <= 0 || p >= info.n) {
    return false;
  }
  const prev = p - 1;
  if (info.fenceAfter[prev] !== 0) {
    return false; // 上一行结束于围栏内：切下去会把围栏劈开
  }
  if (info.table[prev] === 1 && info.table[p] === 1) {
    return false; // 连续表格行整块不切
  }
  if (info.setext[p] === 1) {
    return false; // 不把 setext 下划线从标题文字上撕下来
  }
  return true;
}

/**
 * 在 cuts 中找满足 `start < c < end && prefix[c] - prefix[start] <= maxBytes` 的最大切点。
 * 三个条件对下标都单调，可二分；找不到返回 -1。
 */
function findLastCutWithin(cuts, start, end, byteLimit, prefix) {
  let lo = 0;
  let hi = cuts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = cuts[mid];
    if (cut >= end) {
      hi = mid - 1;
      continue;
    }
    if (prefix[cut] > byteLimit) {
      hi = mid - 1;
      continue;
    }
    if (cut <= start) {
      lo = mid + 1;
      continue;
    }
    found = mid;
    lo = mid + 1;
  }
  return found >= 0 ? cuts[found] : -1;
}

/** 在 cuts 中找第一个满足 `start < c < end` 的切点（超长块被迫在预算外找落点）。 */
function findFirstCutWithin(cuts, start, end) {
  let lo = 0;
  let hi = cuts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = cuts[mid];
    if (cut <= start) {
      lo = mid + 1;
    } else if (cut >= end) {
      hi = mid - 1;
    } else {
      found = mid;
      hi = mid - 1;
    }
  }
  return found >= 0 ? cuts[found] : -1;
}

/**
 * 把超长区间 [start, end) 按预算切块：优先段落边界，其次普通行边界，
 * 仍切不开（原子围栏/表格）时在预算外找第一个安全落点；完全没有落点则整段保留。
 * @returns {{start: number, end: number}[]}
 */
function splitRange(start, end, maxBytes, prefix, lineCuts, paraCuts) {
  const pieces = [];
  let cursor = start;
  while (prefix[end] - prefix[cursor] > maxBytes) {
    const byteLimit = prefix[cursor] + maxBytes;
    let cut = findLastCutWithin(paraCuts, cursor, end, byteLimit, prefix);
    if (cut < 0) {
      cut = findLastCutWithin(lineCuts, cursor, end, byteLimit, prefix);
    }
    if (cut < 0) {
      cut = findFirstCutWithin(lineCuts, cursor, end);
    }
    if (cut < 0) {
      break; // 剩余部分是原子结构（超长围栏/表格）：整段保留，允许超过单块上限
    }
    pieces.push({ start: cursor, end: cut });
    cursor = cut;
  }
  pieces.push({ start: cursor, end });
  return pieces;
}

function normalizeMaxBlockBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : MAX_BLOCK_BYTES;
}

/**
 * 把 markdown 切成适合渐进渲染的块（零丢失）。
 * 口径：先按标题行切段 → 相邻小段合并到接近 maxBlockBytes（块仍从标题开始）
 * → 单段超长再按空行段落切 → 仍超长按行切；围栏/表格/setext 边界受保护。
 * @param {string} markdown
 * @param {{maxBlockBytes?: number}} [options]
 * @returns {{blocks: string[], totalBytes: number}} totalBytes 是全文 UTF-8 字节数
 */
export function splitBlocks(markdown, options = {}) {
  const text = String(markdown ?? '');
  const maxBlockBytes = normalizeMaxBlockBytes(options && options.maxBlockBytes);
  if (text.length === 0) {
    return { blocks: [], totalBytes: 0 };
  }

  const lines = splitLines(text);
  const info = analyzeLines(lines);
  const prefix = new Array(info.n + 1);
  prefix[0] = 0;
  for (let i = 0; i < info.n; i += 1) {
    prefix[i + 1] = prefix[i] + utf8Length(lines[i]);
  }

  const headingCuts = [];
  const lineCuts = [];
  const paraCuts = [];
  for (let p = 1; p < info.n; p += 1) {
    if (!isSafeBefore(p, info)) {
      continue;
    }
    lineCuts.push(p);
    if (info.blank[p] === 1 || info.blank[p - 1] === 1) {
      paraCuts.push(p);
    }
    if (info.heading[p] === 1) {
      headingCuts.push(p);
    }
  }

  // 先按标题行切段（标题行之前的边界都是安全位置）
  const sections = [];
  let sectionStart = 0;
  for (const cut of headingCuts) {
    if (cut > sectionStart) {
      sections.push({ start: sectionStart, end: cut });
      sectionStart = cut;
    }
  }
  sections.push({ start: sectionStart, end: info.n });

  // 合并相邻段直到接近上限；超长段再细分。块起点因此优先落在标题行。
  const ranges = [];
  let current = null;
  for (const section of sections) {
    const bytes = prefix[section.end] - prefix[section.start];
    if (bytes <= maxBlockBytes) {
      if (current && current.bytes + bytes <= maxBlockBytes) {
        current.end = section.end;
        current.bytes += bytes;
      } else {
        if (current) {
          ranges.push(current);
        }
        current = { start: section.start, end: section.end, bytes };
      }
      continue;
    }
    if (current) {
      ranges.push(current);
      current = null;
    }
    for (const piece of splitRange(section.start, section.end, maxBlockBytes, prefix, lineCuts, paraCuts)) {
      ranges.push({ start: piece.start, end: piece.end, bytes: prefix[piece.end] - prefix[piece.start] });
    }
  }
  if (current) {
    ranges.push(current);
  }

  const blocks = ranges.map((range) => lines.slice(range.start, range.end).join(''));
  return { blocks, totalBytes: prefix[info.n] };
}

/** 是否进入大文件模式（brief 阈值：20 MB）。 */
export function isHuge(markdown) {
  return String(markdown ?? '').length >= HUGE_THRESHOLD;
}

/** 生产观察器：全局 IntersectionObserver 可用时构造；不可用返回 null。 */
function defaultObserverFactory(onIntersect, root) {
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== 'function') {
    return null;
  }
  const instance = new Observer(
    (entries) => {
      if (Array.isArray(entries) && entries.some((entry) => entry && entry.isIntersecting)) {
        onIntersect();
      }
    },
    { root: root ?? null, rootMargin: OBSERVER_ROOT_MARGIN, threshold: 0 },
  );
  return {
    observe: (element) => instance.observe(element),
    unobserve: (element) => instance.unobserve(element),
    disconnect: () => instance.disconnect(),
  };
}

/**
 * 渐进渲染器：首屏同步渲染累计 HTML 字节 ≤ initialBytes 的块（首块无条件），
 * 其余块由哨兵 IntersectionObserver 逐块渲染（插在哨兵前，保持 DOM 顺序）；
 * 全部渲染完移除哨兵并断开观察器。
 * @param {{
 *   container: Element,
 *   render: (blockText: string) => string,
 *   blocks: string[],
 *   initialBytes?: number,
 *   observerFactory?: (onIntersect: () => void) => {observe: Function, unobserve?: Function, disconnect: Function},
 *   onChunkRendered?: (info: {index: number, count: number, container: Element}) => void,
 *   observerRoot?: Element|null,
 * }} options
 * @returns {{start: () => void, renderAll: () => number, renderedCount: () => number, destroy: () => void}}
 */
export function createChunkedRenderer(options = {}) {
  const host = options.container;
  if (!host || typeof host.insertAdjacentHTML !== 'function' || typeof host.append !== 'function') {
    throw new TypeError('createChunkedRenderer: 缺少可插入内容的 container');
  }
  const list = Array.isArray(options.blocks) ? options.blocks.map((block) => String(block ?? '')) : [];
  const renderBlock = typeof options.render === 'function' ? options.render : (blockText) => blockText;
  const budgetNumber = Number(options.initialBytes);
  const budget = Number.isFinite(budgetNumber) ? budgetNumber : INITIAL_BYTES;
  const emitChunk = typeof options.onChunkRendered === 'function' ? options.onChunkRendered : null;

  let started = false;
  let finished = false;
  let sentinel = null;
  let observer = null;
  let usedBytes = 0;
  let renderedCount = 0;
  let pending = null; // 预算中断时「已渲染但未插入」的块，下次直接复用，避免重复解析

  function insertHtml(html) {
    if (!html) {
      return;
    }
    if (sentinel && sentinel.parentNode === host) {
      sentinel.insertAdjacentHTML('beforebegin', html);
    } else {
      host.insertAdjacentHTML('beforeend', html);
    }
  }

  function emit(index) {
    if (!emitChunk) {
      return;
    }
    try {
      emitChunk({ index, count: list.length, container: host });
    } catch {
      // 回调失败（增强/统计异常）不能中断正文渲染
    }
  }

  function takeHtml(index) {
    if (pending && pending.index === index) {
      const value = pending;
      pending = null;
      return value;
    }
    const html = String(renderBlock(list[index]) ?? '');
    return { index, html, bytes: utf8Length(html) };
  }

  function renderAt(index) {
    const value = takeHtml(index);
    insertHtml(value.html);
    usedBytes += value.bytes;
    renderedCount = index + 1;
    emit(index);
  }

  function observeSentinel() {
    if (!observer || !sentinel || finished) {
      return;
    }
    try {
      if (typeof observer.unobserve === 'function') {
        observer.unobserve(sentinel);
      }
      observer.observe(sentinel);
    } catch {
      // 观察失败不阻断：TOC 点击/手动 renderAll 仍能看到后续内容
    }
  }

  function finish() {
    finished = true;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        // disconnect 失败不影响已渲染内容
      }
      observer = null;
    }
    if (sentinel) {
      sentinel.remove();
      sentinel = null;
    }
  }

  function onIntersect() {
    if (!started || finished) {
      return;
    }
    if (renderedCount >= list.length) {
      finish();
      return;
    }
    renderAt(renderedCount);
    if (renderedCount >= list.length) {
      finish();
      return;
    }
    // 哨兵被新内容顶下去后可能仍留在观察区内：重新 observe 让观察器再触发一次，直到全部渲染完
    observeSentinel();
  }

  function ensureObserver() {
    if (observer) {
      return true;
    }
    const factory =
      typeof options.observerFactory === 'function'
        ? options.observerFactory
        : (onIntersectCallback) => defaultObserverFactory(onIntersectCallback, options.observerRoot);
    try {
      observer = factory(onIntersect) || null;
    } catch {
      observer = null;
    }
    return Boolean(observer);
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    if (list.length === 0) {
      finished = true;
      return;
    }

    let index = 0;
    while (index < list.length) {
      const value = takeHtml(index);
      if (index > 0 && usedBytes + value.bytes > budget) {
        pending = value;
        break;
      }
      insertHtml(value.html);
      usedBytes += value.bytes;
      renderedCount = index + 1;
      index += 1;
      emit(index - 1);
    }

    if (index >= list.length) {
      finished = true;
      return;
    }

    sentinel = globalThis.document.createElement('div');
    sentinel.className = SENTINEL_CLASS;
    sentinel.setAttribute('aria-hidden', 'true');
    host.append(sentinel);
    if (!ensureObserver()) {
      // 环境不支持 IntersectionObserver：直接渲染全部，绝不让正文卡在半截
      renderAll();
      return;
    }
    observeSentinel();
  }

  function renderAll() {
    if (!started) {
      started = true;
    }
    while (renderedCount < list.length) {
      renderAt(renderedCount);
    }
    finish();
    return renderedCount;
  }

  return {
    start,
    renderAll,
    renderedCount: () => renderedCount,
    destroy: finish,
  };
}
