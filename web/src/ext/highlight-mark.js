// ==高亮== 扩展（Task 8）：==文本== → <mark>文本</mark>。
// 只处理同一行内的成对 ==（不跨行）；空内容（====）与未闭合的 == 保持原样文本；
// 行内代码与围栏代码天然不进 inline 规则，因此其中的 == 不会被转换。
// 内部的 markdown 按普通 inline 语法再解析一次（手法同 markdown-it 的 image alt），因此 ==**重点**== 支持嵌套强调。
export function install(md) {
  // 自定义 token 的渲染规则：只产出 <mark>/</mark> 两个标签（标签与属性都在 T7 清洗白名单内）。
  md.renderer.rules.jj_mark_open = () => '<mark>';
  md.renderer.rules.jj_mark_close = () => '</mark>';

  md.inline.ruler.before('emphasis', 'jj_mark', (state, silent) => {
    const { src } = state;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x3d /* = */ || src.charCodeAt(start + 1) !== 0x3d /* = */) {
      return false;
    }
    // 只在当前行内找闭合 ==：行内代码/链接等其它语法已在此之前被各自规则消费，不会误入。
    const newline = src.indexOf('\n', start + 2);
    const limit = newline < 0 ? state.posMax : Math.min(newline, state.posMax);
    let close = -1;
    for (let i = start + 2; i + 1 < limit; i += 1) {
      if (src.charCodeAt(i) === 0x3d && src.charCodeAt(i + 1) === 0x3d) {
        close = i;
        break;
      }
    }
    // close === start + 2 表示空内容（====），按任务书要求原样输出
    if (close <= start + 2) {
      return false;
    }
    const content = src.slice(start + 2, close);
    state.pos = close + 2;
    if (silent) {
      return true;
    }

    // 内部再按 inline 语法解析（递归内容一定比原文短，不会有无限递归）。
    const inner = [];
    state.md.inline.parse(content, state.md, state.env, inner);
    state.push('jj_mark_open', 'mark', 1);
    for (const token of inner) {
      state.tokens.push(token);
      // tokens_meta 与 tokens 必须等长（后续 emphasis/balance_pairs 按它遍历）
      state.tokens_meta.push(null);
    }
    state.push('jj_mark_close', 'mark', -1);
    return true;
  });
}
