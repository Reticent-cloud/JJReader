// [TOC] 内联目录扩展（Task 9）：独占一行的 [TOC]/[toc] 就地生成整篇文档的扁平目录。
// 目录内容由 renderMarkdown 在渲染前用 extractHeadings 预扫描得到（与侧栏 TOC 共用同一套标题 id），
// 块级规则只负责把本次渲染 env.tocHtml 里的 HTML 放进文档流（html_block token，出口仍统一过 sanitizeHtml）。
// 口径：<nav class="toc-inline"><ol><li data-level="n"><a href="#id">标题文本</a></li></ol></nav>；
// 扁平列表（不嵌套 <ol>）；无标题时输出空 <nav class="toc-inline"></nav>；代码块/普通段落里的 [TOC] 不转换。

/** 独占行的 [TOC]（大小写不敏感）；行首行尾空白由调用方 trim 处理。 */
const TOC_LINE_RE = /^\[toc\]$/i;

/** 单字符空白判定（与 String.trim 同口径：含全角空格 U+3000、NBSP U+00A0）；单字符类无回溯风险。 */
const BLANK_RE = /\s/;

/** 引用块前缀字符 `>`（逐字符剥离用）。 */
const QUOTE_CHAR = '>';

/** HTML 转义映射：标题文本来自 Markdown（可能含 < & "），属性值与文本节点都要转义。 */
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

function escapeHtml(text) {
  return String(text ?? '').replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/**
 * 由标题列表 [{ id, text, level }] 生成内联目录 HTML（纯函数，renderMarkdown 预扫描后放进 env.tocHtml）。
 * id 由 slugify 生成（字母/数字/组合记号与 '-'），这里仍统一转义：本函数产出的是 HTML 字符串，不能有任何拼接漏洞。
 */
export function buildTocHtml(headings) {
  if (!Array.isArray(headings) || headings.length === 0) {
    return '<nav class="toc-inline"></nav>';
  }
  const items = headings
    .filter((heading) => heading && typeof heading === 'object')
    .map((heading) => {
      const level = Number(heading.level);
      const safeLevel = Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
      return `<li data-level="${safeLevel}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`;
    })
    .join('');
  return `<nav class="toc-inline"><ol>${items}</ol></nav>`;
}

/**
 * 单行是否为块级规则会命中的独占行 [TOC]：String.trim() 去行首行尾空白后，
 * 剥离引用块前缀 `>`（可重复、前缀间允许空白），剩余内容恰为 `[toc]`（大小写不敏感）。
 * 全程逐字符线性扫描、不用正则：旧的 /^(?:[ \t]*>[ \t]*)*…/im 对「> * N + 非空白文字」灾难性回溯。
 * trim 口径与块规则一致（含全角空格 U+3000、NBSP），因此预扫描与块规则不会一个命中一个漏判。
 */
function isTocLine(line) {
  const text = line.trim();
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (text[i] !== QUOTE_CHAR) {
      break;
    }
    i += 1;
    while (i < len && BLANK_RE.test(text[i])) {
      i += 1;
    }
  }
  if (len - i !== 5) {
    return false; // `[toc]` 固定 5 字符：长行不必再做大小写转换
  }
  return text.slice(i).toLowerCase() === '[toc]';
}

/**
 * 文档里是否存在独占行 [TOC]：没有占位符就不必为了预扫描多付一次 parse 开销。
 * 逐行扫描（split(/\r?\n/) + 每行 trim 后精确比较），不做正则回溯；大小写不敏感。
 * 引用块里的 `> [TOC]` 也命中（块级规则在 blockquote 内层 token 化，能真正转换）；
 * 代码块里的 [TOC] 也会命中，只是多算一次目录、最终不输出（块级规则不会在代码块内触发），行为无害。
 */
export function hasTocPlaceholder(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (isTocLine(lines[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 装配块级规则：把独占行的 [TOC] 换成 env.tocHtml（html_block）。
 * 注册在 paragraph 之前、缩进代码块/围栏代码块规则之后，因此代码块内的 [TOC] 不会被转换；
 * 加进 paragraph 的 terminator 规则（alt: ['paragraph']），让「文字\n[TOC]」这种无空行写法也能正确断开段落。
 */
export function install(md) {
  md.block.ruler.before(
    'paragraph',
    'jj_toc',
    (state, startLine, endLine, silent) => {
      if (startLine >= endLine) {
        return false;
      }
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const end = state.eMarks[startLine];
      if (!TOC_LINE_RE.test(state.src.slice(start, end).trim())) {
        return false;
      }
      if (silent) {
        return true;
      }
      const token = state.push('html_block', '', 0);
      token.map = [startLine, startLine + 1];
      token.block = true;
      token.content =
        state.env && typeof state.env.tocHtml === 'string'
          ? state.env.tocHtml
          : '<nav class="toc-inline"></nav>';
      state.line = startLine + 1;
      return true;
    },
    { alt: ['paragraph'] },
  );
}
