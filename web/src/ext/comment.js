// %%注释%% 扩展（Task 8）：行内注释与独占行的注释块都不渲染（阅读器只需要「隐藏」，不需要保留到 DOM）。
// 口径：
//   - 行内规则只处理同一行内的 %%…%%（不跨行），未闭合时原样保留；
//   - 块级规则处理两种「独占行」写法：整行 %%注释%%（注释之外无其它文字），或 %% 独占一行 … %% 独占一行 的多行块；
//   - %% 紧跟在数字或 % 之后时不认作注释起点，避免「100%%」把后半行文字当成注释吞掉；
//   - 围栏/缩进代码块由各自的块级规则先行消费，其中的 %% 原样显示；行内代码同理不会进入本行内规则。
const PERCENT = 0x25;

/** 判断行内注释起点前一个字符是否让它「不可能是注释」：数字（100%%）或 %（%%%/%%%%）。 */
function isBlockedCommentStart(prevCode) {
  return prevCode === PERCENT || (prevCode >= 0x30 && prevCode <= 0x39);
}

/** 行内 %%注释%%：匹配成功即整段删除（不产生 token），未闭合返回 false 由原文本兜底。 */
function commentInline(state) {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== PERCENT || src.charCodeAt(start + 1) !== PERCENT) {
    return false;
  }
  if (start > 0 && isBlockedCommentStart(src.charCodeAt(start - 1))) {
    return false;
  }
  const newline = src.indexOf('\n', start + 2);
  const limit = newline < 0 ? state.posMax : Math.min(newline, state.posMax);
  let close = -1;
  for (let i = start + 2; i + 1 < limit; i += 1) {
    if (src.charCodeAt(i) === PERCENT && src.charCodeAt(i + 1) === PERCENT) {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return false;
  }
  state.pos = close + 2;
  return true;
}

/** 取某一行的内容（去掉行首缩进与行尾空白）。 */
function lineText(state, line) {
  const start = state.bMarks[line] + state.tShift[line];
  return state.src.slice(start, state.eMarks[line]).trim();
}

/**
 * 块级注释：整行 %%注释%%（单行）或 %% 独占一行 … %% 独占一行（多行）。
 * 未闭合的块一律原样保留，绝不吞掉后文。
 * silent 模式（段落中断探测）只判断能否匹配，不改 state.line。
 */
function commentBlock(state, startLine, endLine, silent) {
  const text = lineText(state, startLine);
  if (!text.startsWith('%%')) {
    return false;
  }

  if (text === '%%') {
    for (let line = startLine + 1; line < endLine; line += 1) {
      if (lineText(state, line) === '%%') {
        if (!silent) {
          state.line = line + 1;
        }
        return true;
      }
    }
    return false;
  }

  // 单行整行注释：第一个 %%…%% 之外不允许还有其它非空白内容（%%a%% 与「%%a%%文字%%b%%」要区分开）
  const close = text.indexOf('%%', 2);
  if (close < 0 || text.slice(close + 2).trim() !== '') {
    return false;
  }
  if (!silent) {
    state.line = startLine + 1;
  }
  return true;
}

export function install(md) {
  const blockRule = (state, startLine, endLine, silent) =>
    commentBlock(state, startLine, endLine, silent);
  md.block.ruler.before('fence', 'jj_comment_block', blockRule, { alt: ['paragraph'] });
  md.inline.ruler.before('emphasis', 'jj_comment_inline', commentInline);
}
