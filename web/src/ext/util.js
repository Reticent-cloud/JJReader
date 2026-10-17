// 笔记体扩展语法共用工具（Task 8）：wikilink 与 attachment 都要解析 [[目标|别名]] 这种同行内的目标写法。
// 只做纯文本切分：不创建 token、不推进 state.pos，由各插件在确认可用后自行推进。
// 修复波 B（DoS）：旧实现每个 `[[` 都从 openPos 扫到文档末尾找 `]]`，`'[[x'.repeat(5000)` 这类
// 无闭合输入会退化成 O(n²)。现在按源码缓存「换行位置 + `]]` 位置」两个有序数组（一次 O(n) 扫描），
// 每次查询用二分；并在单行/最多 2000 字符 label 处硬上限，避免超长单行反复扫描。

/** `[[` / `]]` 定界符长度（两边一致，便于阅读调用点）。 */
const BRACKET_OPEN = '[[';
const BRACKET_CLOSE = ']]';

/** 单次解析允许的最大 label 长度（字符）：笔记链接的目标/别名不可能这么长，超过按「不是链接」处理。 */
const MAX_LABEL_CHARS = 2000;

/** 源码缓存：只缓存最近一次传入的字符串（markdown-it 一次解析同一份源码）。 */
let cachedSource = null;
let cachedNewlines = null;
let cachedCloses = null;

/** 全量扫描一次源码，缓存换行与 `]]` 的位置（升序）。 */
function ensureIndexes(src) {
  if (cachedSource === src && cachedNewlines !== null && cachedCloses !== null) {
    return;
  }
  const newlines = [];
  const closes = [];
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    if (code === 10) {
      newlines.push(i);
      continue;
    }
    if (code === 93 /* ] */ && src.charCodeAt(i + 1) === 93) {
      closes.push(i);
      i += 1;
    }
  }
  cachedSource = src;
  cachedNewlines = newlines;
  cachedCloses = closes;
}

/** 在升序数组里找第一个 >= value 的元素（找不到返回 -1）。 */
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] >= value) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/**
 * 从 openPos（指向 `[[` 的第一个 `[`）解析到同一行内最近的 `]]`。
 * 别名取第一个 `|` 之后的文本；目标与别名都去首尾空格；跨行的 `]]` 不算（笔记体语法不跨行）。
 * 复杂度：每个匹配 O(log n)（位置索引二分），无匹配输入不再扫描到文档末尾。
 * @param {string} src inline 规则拿到的整段源码
 * @param {number} openPos `[[` 起始位置
 * @param {number} [maxPos] 可用范围上界（markdown-it 在链接文本等子区间解析时会临时收窄 state.posMax）
 * @returns {{ target: string, alias: string, end: number } | null} 目标、别名（可为空串）与闭合 `]]` 之后的位置
 */
export function splitBracketed(src, openPos, maxPos) {
  if (
    typeof src !== 'string'
    || typeof openPos !== 'number'
    || openPos < 0
    || src.slice(openPos, openPos + BRACKET_OPEN.length) !== BRACKET_OPEN
  ) {
    return null;
  }

  const innerStart = openPos + BRACKET_OPEN.length;
  ensureIndexes(src);

  // 当前行边界：下一个换行的位置
  const newlineIndex = lowerBound(cachedNewlines, innerStart);
  const boundary = newlineIndex >= 0 ? cachedNewlines[newlineIndex] : src.length;
  const limit = typeof maxPos === 'number' ? Math.min(boundary, maxPos) : boundary;
  if (limit - innerStart > MAX_LABEL_CHARS) {
    return null;
  }

  // 同一行内最近的 `]]`
  const closeIndex = lowerBound(cachedCloses, innerStart);
  if (closeIndex < 0) {
    return null;
  }
  const close = cachedCloses[closeIndex];
  // 闭合必须完整落在当前行的可用范围内（close + 2 <= limit）
  if (close + BRACKET_CLOSE.length > limit) {
    return null;
  }

  const inner = src.slice(innerStart, close);
  const pipe = inner.indexOf('|');
  const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe < 0 ? '' : inner.slice(pipe + 1).trim();
  return { target, alias, end: close + BRACKET_CLOSE.length };
}
