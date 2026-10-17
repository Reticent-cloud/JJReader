// 鲸鲸阅读器大文档分块（Task 11）：切块算法 + 渐进渲染器 + 大文件阈值。
// 设计约束（与 Controller 决策一致）：
//   - 切块零丢失：blocks.join('') === markdown；
//   - 围栏代码块（``` / ~~~ 开头）与连续表格行是原子结构，块边界绝不落在其中；
//   - 块边界优先落在标题行（^#{1,6}\s）之前，其次空行段落，最后普通行边界；
//   - 首屏预算按「渲染出的 HTML UTF-8 字节数」计（真正的首屏 DOM/布局成本），首块无条件渲染（不空屏）；
//   - 懒加载观察器可注入（jsdom 无 IntersectionObserver，测试用 observerFactory 桩；生产用全局实现）；
//   - 每次插入把本批块合并成一个 DocumentFragment（renderAll/首屏只做一次 DOM 插入），并把新增顶层元素
//     经 onChunkRendered({nodes}) 交给调用方——调用方只增强/只配对这些新节点，避免「每块重扫整个容器」的
//     O(n²) 冻结；
//   - 跨块引用式链接定义：全文预抽取后用 appendLinkDefinitions 追加到每块末尾（定义不产生输出；脚注定义
//     [^1]: 不在抽取范围——跨块脚注是已知限制，见任务报告）。
// 安全口径：createChunkedRenderer 只把 render(blockText) 的返回值插入容器，render 由调用方提供
// （shell 传 JJ.renderMarkdown，出口已过 DOMPurify）；本模块不拼任何不可信 HTML。
// 修复波 B-I2（前端评审）：结构保护扩展到 markdown-it 的真实语法——
//   - 无前导 `|` 的 GFM 表格（分隔行 + 连续含 `|` 行）整块不切；
//   - 引用块/列表项内的围栏（`> ``` `、`- ```` `）也识别为围栏；
//   - HTML 块（块级开标签到空行）整块不切；
//   - front matter 用引擎的 extractFrontmatter 校验：无效 YAML 不算惰性块，避免首块超预算。

import { extractFrontmatter } from './engine.js';

/** 超过这个字节数走分块渲染（brief：512 KB）。 */
export const CHUNK_THRESHOLD = 512 * 1024;
/** 首屏渲染预算：累计渲染 HTML 字节数不超过该值（brief：256 KB）。 */
export const INITIAL_BYTES = 256 * 1024;
/** 单块上限（结构性原子块——超长围栏/表格——允许超出）（brief：64 KB）。 */
export const MAX_BLOCK_BYTES = 64 * 1024;
/** 大文件模式阈值：关闭代码高亮、不启用滚动联动（brief：20 MB）。 */
export const HUGE_THRESHOLD = 20 * 1024 * 1024;

/** 标题行：按 brief 口径 `^#{1,6}\s`（顶层行；引用/列表内的标题不参与段切分）。 */
const HEADING_RE = /^#{1,6}\s/;
/** 空行（含只有空白的行）。 */
const BLANK_RE = /^\s*$/;
/** 围栏起始行：最多 3 个前导空格 + 3 个以上 ` 或 ~（在剥离容器前缀后的行上匹配）。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Setext 标题的下划线行：切在它前面会把标题文字与下划线拆开。 */
const SETEXT_RE = /^ {0,3}(?:=+|-+)\s*$/;
/** 引用块前缀：最多 3 个前导空格 + `>` + 可选空格（可嵌套，最多剥 3 层）。 */
const QUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/;
/** 列表项前缀：`-`/`+`/`*` 或 `1.`/`1)` + 空白（可嵌套；任务清单的 `[ ] ` 另剥）。 */
const LIST_ITEM_PREFIX_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
/** 任务清单前缀：列表项内容开头的 `[ ] ` / `[x] `。 */
const TASK_PREFIX_RE = /^\[[ xX]\][ \t]+/;
/** 无前导 `|` 的表格分隔行：`--- | ---`、`:---: | ---:`（至少一个 `|`；有前导 `|` 也命中）。 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}/;
/** 块级 HTML 开标签：从该行起直到空行整块不切（与 CommonMark HTML block 的常见形态一致）。 */
const HTML_BLOCK_OPEN_RE =
  /^ {0,3}<(?:address|article|aside|audio|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|section|source|style|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|video)(?=[\s/>]|$)/i;
/** 文档开头的 front matter 块（与 ext/frontmatter.js 口径一致）：内部 `#` 注释行不能当标题切点。 */
const FRONT_MATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;
/** 引用式链接定义起始行：`[label]:`（最多 3 个前导空格；label 允许转义字符）。 */
const REF_DEF_RE = /^ {0,3}\[((?:[^\\\]\n]|\\.)+)\]:/;
/** 脚注标签前缀：脚注定义不参与跨块补齐（分块独立 parse 的已知限制）。 */
const FOOTNOTE_LABEL_RE = /^\^/;
/** 懒加载哨兵的 class（CSS 只需给它 1px 高度即可被观察）。 */
export const SENTINEL_CLASS = 'chunk-sentinel';
/** 哨兵提前触发距离：接近视口底部就渲染下一块，滚动更顺。 */
const OBSERVER_ROOT_MARGIN = '800px 0px';

/** HTML 文本转义（单块渲染失败时把该块原文当纯文本展示，绝不把原文当 HTML 执行）。 */
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

function escapeHtml(text) {
  return String(text ?? '').replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

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
 * 文首 front matter 占用的行数（无 front matter / 未闭合 / 无效 YAML 时 0）。
 * front matter 是原子块：内部行不参与围栏/标题/表格/setext 判定，也不允许产生块切点。
 * 修复波 B：用引擎的 extractFrontmatter 校验——解析失败时正文并未被剥离（body===原文），
 * 这时把整块当惰性会让首块超出预算，因此按 0 处理（内部行恢复普通结构判定）。
 */
function frontMatterLineCount(text) {
  const match = FRONT_MATTER_RE.exec(text);
  if (!match) {
    return 0;
  }
  const parsed = extractFrontmatter(text);
  if (!parsed || typeof parsed.body !== 'string' || parsed.body === text) {
    return 0; // 无效 YAML：引擎不剥离，分块也不应把整块当原子
  }
  const newlines = (match[0].match(/\n/g) ?? []).length;
  return match[0].endsWith('\n') ? newlines : newlines + 1;
}

/**
 * 剥离围栏判定用的容器前缀（修复波 B-I2）：最多 3 层引用 `>` 与列表项缩进/任务清单前缀。
 * 例：`> ``` ` → ```` ``` ````；`- ~~~ js` → `~~~ js`；`> - `` ` → ``` ``` `。
 * 只用于结构识别（围栏/表格/setext/HTML 块），不改变原文与切块内容。
 */
function stripContainerPrefixes(line) {
  let text = String(line ?? '');
  for (let depth = 0; depth < 3; depth += 1) {
    const match = QUOTE_PREFIX_RE.exec(text);
    if (!match) {
      break;
    }
    text = text.slice(match[0].length);
  }
  for (let depth = 0; depth < 4; depth += 1) {
    const match = LIST_ITEM_PREFIX_RE.exec(text);
    if (!match) {
      break;
    }
    text = text.slice(match[0].length);
    const task = TASK_PREFIX_RE.exec(text);
    if (task) {
      text = text.slice(task[0].length);
    }
  }
  return text;
}

/**
 * 逐行分析结构：围栏深度、表格块、HTML 块、空行、标题行、setext 下划线。
 * fenceBefore/fenceAfter 是「该行之前/之后是否在围栏内」，用于判断块边界是否落在围栏外。
 * skipLines：前 N 行（front matter）按惰性行处理——不产生围栏状态与任何结构标记。
 */
function analyzeLines(lines, skipLines = 0) {
  const n = lines.length;
  const inertLines = Math.max(0, Math.min(Number(skipLines) || 0, n));
  const fenceBefore = new Uint8Array(n);
  const fenceAfter = new Uint8Array(n);
  const blank = new Uint8Array(n);
  const heading = new Uint8Array(n);
  const setext = new Uint8Array(n);
  const rowPipe = new Uint8Array(n);
  const separator = new Uint8Array(n);
  const table = new Uint8Array(n);
  const htmlBlock = new Uint8Array(n);
  // 引用/列表容器内的围栏起始行：切在它前面会把围栏从容器里撕出来（顶层围栏不受此限制）。
  const nestedFenceStart = new Uint8Array(n);

  let open = null; // { symbol: '`' | '~', length: number }
  let closeRe = null;

  for (let i = 0; i < n; i += 1) {
    const line = lines[i];
    fenceBefore[i] = open ? 1 : 0;
    if (i < inertLines) {
      // front matter 内部：不打开/不关闭围栏、不算标题与切点（避免内部 `# 注释`/``` 产生游离切点）
      fenceAfter[i] = 0;
      continue;
    }
    // 引用块/列表项内的围栏也要识别：结构判定统一用剥离容器前缀后的文本。
    const structural = stripContainerPrefixes(line);
    if (!open) {
      const match = FENCE_OPEN_RE.exec(structural);
      if (match) {
        const marker = match[1];
        open = { symbol: marker.charAt(0), length: marker.length };
        closeRe = new RegExp(`^ {0,3}${open.symbol === '`' ? '`' : '~'}{${open.length},}\\s*$`);
        // 引用/列表内的围栏：结构文本与原文不同（剥过 `>`/列表前缀），或围栏本身有缩进
        // （列表项内容通常缩进 2+ 空格）。这类起始行前不切，避免把围栏从容器里撕出来。
        if (structural !== line || /^[ \t]/.test(line)) {
          nestedFenceStart[i] = 1;
        }
      }
    } else if (closeRe && closeRe.test(structural)) {
      open = null;
      closeRe = null;
    }
    fenceAfter[i] = open ? 1 : 0;

    const inFence = fenceBefore[i] === 1 || fenceAfter[i] === 1;
    blank[i] = BLANK_RE.test(line) ? 1 : 0;
    heading[i] = fenceBefore[i] === 0 && HEADING_RE.test(line) ? 1 : 0;
    setext[i] = !inFence && SETEXT_RE.test(structural) ? 1 : 0;
    if (!inFence) {
      const trimmed = structural.trim();
      rowPipe[i] = trimmed !== '' && trimmed.includes('|') ? 1 : 0;
      separator[i] = rowPipe[i] === 1 && TABLE_SEPARATOR_RE.test(structural) ? 1 : 0;
    }
  }

  // 表格块：从分隔行向上收表格头、向下收连续含 `|` 的非围栏行；整块标为原子，切点不落在其中。
  for (let i = 0; i < n; i += 1) {
    if (table[i] === 1) {
      continue; // 已经属于前一个表格块：避免连续分隔行把同一段数据反复扫描成 O(n²)
    }
    if (separator[i] !== 1 || fenceBefore[i] === 1 || fenceAfter[i] === 1) {
      continue;
    }
    let start = i - 1;
    if (start < inertLines || rowPipe[start] !== 1 || fenceBefore[start] === 1 || fenceAfter[start] === 1) {
      continue; // 分隔行上方没有表头行：不是表格（例如单独一行 `--- | ---` 更像段落）
    }
    while (
      start - 1 >= inertLines
      && rowPipe[start - 1] === 1
      && fenceBefore[start - 1] === 0
      && fenceAfter[start - 1] === 0
    ) {
      start -= 1;
    }
    let end = i;
    while (end + 1 < n && rowPipe[end + 1] === 1 && fenceBefore[end + 1] === 0 && fenceAfter[end + 1] === 0) {
      end += 1;
    }
    for (let row = start; row <= end; row += 1) {
      table[row] = 1;
    }
  }

  // HTML 块：块级开标签行开始，到空行为止（含）整块原子。
  for (let i = inertLines; i < n; i += 1) {
    if (fenceBefore[i] === 1 || fenceAfter[i] === 1 || blank[i] === 1) {
      continue;
    }
    const structural = stripContainerPrefixes(lines[i]);
    if (!HTML_BLOCK_OPEN_RE.test(structural)) {
      continue;
    }
    htmlBlock[i] = 1;
    let end = i + 1;
    while (end < n && blank[end] !== 1) {
      htmlBlock[end] = 1;
      end += 1;
    }
    i = end - 1;
  }

  return { n, inertLines, fenceBefore, fenceAfter, table, htmlBlock, blank, heading, setext, nestedFenceStart };
}

/** 该行是否在围栏代码块内（含开/闭围栏行本身）。 */
function lineInFence(index, info) {
  return info.fenceBefore[index] === 1 || info.fenceAfter[index] === 1;
}

/** 能否在第 p 行之前切块：不在围栏内、不拆表格/HTML 块、不拆 setext 标题。 */
function isSafeBefore(p, info) {
  if (p <= 0 || p >= info.n) {
    return false;
  }
  const prev = p - 1;
  if (info.fenceAfter[prev] !== 0) {
    return false; // 上一行结束于围栏内：切下去会把围栏劈开
  }
  if (info.table[prev] === 1 && info.table[p] === 1) {
    return false; // 表格块整块不切（含无前导 `|` 的 GFM 表格）
  }
  if (info.htmlBlock[prev] === 1 && info.htmlBlock[p] === 1) {
    return false; // HTML 块整块不切
  }
  if (info.setext[p] === 1) {
    return false; // 不把 setext 下划线从标题文字上撕下来
  }
  if (info.nestedFenceStart[p] === 1) {
    return false; // 引用/列表内的围栏：切在它前面会把围栏从容器（列表项/引用块）里撕出来
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
  const info = analyzeLines(lines, frontMatterLineCount(text));
  const prefix = new Array(info.n + 1);
  prefix[0] = 0;
  for (let i = 0; i < info.n; i += 1) {
    prefix[i + 1] = prefix[i] + utf8Length(lines[i]);
  }

  const headingCuts = [];
  const lineCuts = [];
  const paraCuts = [];
  for (let p = 1; p < info.n; p += 1) {
    if (p < info.inertLines) {
      continue; // front matter 内部不切分（内部 `# 注释` 不是标题）
    }
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

/** 是否进入大文件模式（brief 阈值：20 MB，按 UTF-8 字节与 renderDone.bytes 同源）。 */
export function isHuge(markdown) {
  return utf8Length(markdown) >= HUGE_THRESHOLD;
}

/** 引用式链接 label 归一化（与 markdown-it 口径一致：折叠空白、忽略大小写）。 */
function normalizeRefLabel(label) {
  return String(label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 从全文预抽取引用式链接定义（Task 11 修复：分块独立 parse 时定义在文末会失效）。
 * 口径：`^ {0,3}\[label\]:` 起始行 + 其后以空白缩进的续行；围栏代码块内的伪定义不算；
 * 脚注定义（label 以 `^` 开头）不抽取——跨块脚注是已知限制，补进来会改变既有输出（正文里多出脚注区）。
 * 同名 label 只保留第一个（markdown-it 也只认第一个）。
 * @param {string} markdown
 * @returns {{label: string, text: string}[]} text 是可直接追加到块末尾的定义原文（以换行结尾）
 */
export function extractLinkDefinitions(markdown) {
  const text = String(markdown ?? '');
  if (text === '') {
    return [];
  }
  const lines = splitLines(text);
  const info = analyzeLines(lines, frontMatterLineCount(text));
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (lineInFence(i, info)) {
      continue;
    }
    const match = REF_DEF_RE.exec(lines[i]);
    if (!match) {
      continue;
    }
    const rawLabel = match[1];
    if (FOOTNOTE_LABEL_RE.test(rawLabel.trim())) {
      continue;
    }
    const label = normalizeRefLabel(rawLabel);
    if (label === '' || seen.has(label)) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lineInFence(end, info) && /^[ \t]+[^\s]/.test(lines[end])) {
      end += 1;
    }
    let definition = lines.slice(i, end).join('');
    if (!definition.endsWith('\n')) {
      definition += '\n';
    }
    seen.add(label);
    entries.push({ label, text: definition });
    i = end - 1;
  }
  return entries;
}

/**
 * 把全文引用定义里「块自身没有」的部分追加到块文本末尾（定义本身不产生输出，不影响正文）。
 * 块内已有同名定义（围栏代码块里的伪定义不算）时不重复追加；空块不追加。
 * @param {string} blockText
 * @param {{label: string, text: string}[]} definitions extractLinkDefinitions 的结果
 * @returns {string} 交给 renderMarkdown 的块文本
 */
export function appendLinkDefinitions(blockText, definitions) {
  const text = String(blockText ?? '');
  const list = Array.isArray(definitions) ? definitions : [];
  if (text === '' || list.length === 0) {
    return text;
  }
  const lines = splitLines(text);
  const info = analyzeLines(lines, frontMatterLineCount(text));
  const ownLabels = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (lineInFence(i, info)) {
      continue;
    }
    const match = REF_DEF_RE.exec(lines[i]);
    if (match) {
      ownLabels.add(normalizeRefLabel(match[1]));
    }
  }
  const missing = list.filter(
    (entry) => entry && typeof entry.text === 'string' && !ownLabels.has(normalizeRefLabel(entry.label)),
  );
  if (missing.length === 0) {
    return text;
  }
  // 定义必须独占块起点：块尾不是换行时先补一个换行；然后再空一行，避免定义粘到上一段/列表项里。
  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${missing.map((entry) => entry.text).join('')}`;
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
 * 全部渲染完移除哨兵并断开观察器。首屏与 renderAll 的批量插入各只做一次 DOM 操作。
 * @param {{
 *   container: Element,
 *   render: (blockText: string) => string,
 *   blocks: string[],
 *   initialBytes?: number,
 *   observerFactory?: (onIntersect: () => void) => {observe: Function, unobserve?: Function, disconnect: Function},
 *   onChunkRendered?: (info: {index: number, count: number, container: Element, nodes: Element[]}) => void,
 *   onChunkError?: (error: unknown, index: number) => void,
 *   observerRoot?: Element|null,
 * }} options
 * @returns {{start: () => boolean, renderAll: () => number, renderedCount: () => number, destroy: () => void}}
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
  let destroyed = false;
  let sentinel = null;
  let observer = null;
  let usedBytes = 0;
  let renderedCount = 0;
  let pending = null; // 预算中断时「已渲染但未插入」的块，下次直接复用，避免重复解析

  /**
   * 把一批已渲染 HTML 合并成一个 DocumentFragment 一次插入（renderAll/首屏只做一次 DOM 插入），
   * 返回每块新增的顶层元素（供 onChunkRendered 回调做「只增强新节点」）。
   * 极端环境没有 template 时退回字符串插入，此时 nodes 为空（调用方按无新节点处理）。
   */
  function insertBatch(entries) {
    const nodeLists = [];
    if (entries.length === 0) {
      return nodeLists;
    }
    const doc = globalThis.document;
    if (doc && typeof doc.createElement === 'function' && typeof doc.createDocumentFragment === 'function') {
      const batch = doc.createDocumentFragment();
      for (const value of entries) {
        if (!value.html) {
          nodeLists.push([]);
          continue;
        }
        const template = doc.createElement('template');
        template.innerHTML = value.html;
        const nodes = [];
        for (const child of Array.from(template.content.childNodes)) {
          if (child.nodeType === 1) {
            nodes.push(child);
          }
        }
        batch.append(template.content);
        nodeLists.push(nodes);
      }
      if (sentinel && sentinel.parentNode === host) {
        host.insertBefore(batch, sentinel);
      } else {
        host.append(batch);
      }
      return nodeLists;
    }
    for (const value of entries) {
      nodeLists.push([]);
      if (!value.html) {
        continue;
      }
      if (sentinel && sentinel.parentNode === host) {
        sentinel.insertAdjacentHTML('beforebegin', value.html);
      } else {
        host.insertAdjacentHTML('beforeend', value.html);
      }
    }
    return nodeLists;
  }

  function emit(index, nodes) {
    if (!emitChunk) {
      return;
    }
    try {
      emitChunk({ index, count: list.length, container: host, nodes: Array.isArray(nodes) ? nodes : [] });
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
    let html;
    try {
      html = String(renderBlock(list[index]) ?? '');
    } catch (error) {
      // 修复波 B（§5.11）：单块渲染失败不中断分块流程——该块降级为转义 <pre>，后续块继续渲染。
      const source = list[index];
      html = `<pre class="jj-fallback">${escapeHtml(source)}</pre>\n`;
      notifyChunkError(error, index);
    }
    return { index, html, bytes: utf8Length(html) };
  }

  /** 把单块渲染失败报告给调用方（可显示错误条）；回调异常不能影响后续块。 */
  function notifyChunkError(error, index) {
    if (typeof options.onChunkError !== 'function') {
      return;
    }
    try {
      options.onChunkError(error, index);
    } catch {
      // 错误回调失败（例如 UI 已被销毁）时继续渲染剩余块
    }
  }

  function renderAt(index) {
    const value = takeHtml(index);
    const nodeLists = insertBatch([value]);
    usedBytes += value.bytes;
    renderedCount = index + 1;
    emit(index, nodeLists[0]);
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
    if (destroyed || !started || finished) {
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

  /**
   * 首屏：渲染预算内的前缀块（首块无条件），合并成一次 DOM 插入；还有剩余块时挂哨兵。
   * @returns {boolean} false 表示渲染器已 destroy，不再接受启动
   */
  function start() {
    if (destroyed) {
      return false;
    }
    if (started) {
      return true;
    }
    started = true;
    if (list.length === 0) {
      finished = true;
      return true;
    }

    let index = 0;
    const entries = [];
    while (index < list.length) {
      const value = takeHtml(index);
      if (index > 0 && usedBytes + value.bytes > budget) {
        pending = value;
        break;
      }
      usedBytes += value.bytes;
      entries.push(value);
      index += 1;
    }
    renderedCount = index;
    if (entries.length > 0) {
      const nodeLists = insertBatch(entries);
      for (let offset = 0; offset < entries.length; offset += 1) {
        emit(entries[offset].index, nodeLists[offset]);
      }
    }

    if (index >= list.length) {
      finished = true;
      return true;
    }

    sentinel = globalThis.document.createElement('div');
    sentinel.className = SENTINEL_CLASS;
    sentinel.setAttribute('aria-hidden', 'true');
    host.append(sentinel);
    if (!ensureObserver()) {
      // 环境不支持 IntersectionObserver：直接渲染全部，绝不让正文卡在半截
      renderAll();
      return true;
    }
    observeSentinel();
    return true;
  }

  /** 剩余块合并成一批渲染 + 一次 DOM 插入；destroy 后调用是空操作。 */
  function renderAll() {
    if (destroyed) {
      return renderedCount;
    }
    if (!started) {
      started = true;
    }
    if (renderedCount < list.length) {
      const base = renderedCount;
      const entries = [];
      for (let index = base; index < list.length; index += 1) {
        entries.push(takeHtml(index));
      }
      const nodeLists = insertBatch(entries);
      renderedCount = list.length;
      for (let offset = 0; offset < entries.length; offset += 1) {
        usedBytes += entries[offset].bytes;
        emit(base + offset, nodeLists[offset]);
      }
    }
    finish();
    return renderedCount;
  }

  /** 断开观察器并移除哨兵；destroy 后 start 明确拒绝（返回 false），不会留下无观察器的哨兵。 */
  function destroy() {
    destroyed = true;
    finish();
  }

  return {
    start,
    renderAll,
    renderedCount: () => renderedCount,
    destroy,
  };
}
