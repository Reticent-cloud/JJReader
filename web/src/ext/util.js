// 笔记体扩展语法共用工具（Task 8）：wikilink 与 attachment 都要解析 [[目标|别名]] 这种同行内的目标写法。
// 只做纯文本切分：不创建 token、不推进 state.pos，由各插件在确认可用后自行推进。

/** `[[` / `]]` 定界符长度（两边一致，便于阅读调用点）。 */
const BRACKET_OPEN = '[[';
const BRACKET_CLOSE = ']]';

/**
 * 从 openPos（指向 `[[` 的第一个 `[`）解析到同一行内最近的 `]]`。
 * 别名取第一个 `|` 之后的文本；目标与别名都去首尾空格；跨行的 `]]` 不算（笔记体语法不跨行）。
 * @param {string} src inline 规则拿到的整段源码
 * @param {number} openPos `[[` 起始位置
 * @param {number} [maxPos] 可用范围上界（markdown-it 在链接文本等子区间解析时会临时收窄 state.posMax）
 * @returns {{ target: string, alias: string, end: number } | null} 目标、别名（可为空串）与闭合 `]]` 之后的位置
 */
export function splitBracketed(src, openPos, maxPos) {
  if (typeof src !== 'string' || src.slice(openPos, openPos + BRACKET_OPEN.length) !== BRACKET_OPEN) {
    return null;
  }
  const newline = src.indexOf('\n', openPos + BRACKET_OPEN.length);
  const boundary = newline < 0 ? src.length : newline;
  const limit = typeof maxPos === 'number' ? Math.min(boundary, maxPos) : boundary;
  const close = src.indexOf(BRACKET_CLOSE, openPos + BRACKET_OPEN.length);
  // 闭合必须完整落在当前行的可用范围内（close + 2 <= limit）
  if (close < 0 || close + BRACKET_CLOSE.length > limit) {
    return null;
  }
  const inner = src.slice(openPos + BRACKET_OPEN.length, close);
  const pipe = inner.indexOf('|');
  const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe < 0 ? '' : inner.slice(pipe + 1).trim();
  return { target, alias, end: close + BRACKET_CLOSE.length };
}
