// wikilink 扩展（Task 8）：[[目标]] / [[目标|别名]] → <a class="wikilink" href="#" data-target="目标">别名</a>。
// 目标/别名的 HTML 转义交给 markdown-it 的 token 渲染（属性值统一 escapeHtml），插件不拼 HTML 字符串。
// 行内代码与围栏代码天然不进 inline 规则，因此其中的 [[…]] 不会被转换；空目标 [[ ]] 按原样文本输出。
// 点击寻文件是 T13 宿主 NoteResolver 的职责，本插件只产出带 data-target 的链接。
import { splitBracketed } from './util.js';

export function install(md) {
  md.inline.ruler.before('link', 'jj_wikilink', (state, silent) => {
    const { src } = state;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5b /* [ */) {
      return false;
    }
    const parsed = splitBracketed(src, start, state.posMax);
    if (!parsed || !parsed.target) {
      return false;
    }
    // silent 只用于链接文本扫描（parseLinkLabel）：这里返回 false，让 [[ 按普通文本参与括号层级统计，
    // 保证「外链文本里出现 [[x]]」时外链仍能正常解析。
    if (silent) {
      return false;
    }
    // 已经在链接文本里时不再生成嵌套 <a>（HTML 不允许 a 嵌 a），按原样文本输出。
    if (state.linkLevel > 0) {
      return false;
    }
    state.pos = parsed.end;

    const label = parsed.alias || parsed.target;
    const open = state.push('link_open', 'a', 1);
    open.attrs = [
      ['href', '#'],
      ['class', 'wikilink'],
      ['data-target', parsed.target],
    ];
    state.push('text', '', 0).content = label;
    state.push('link_close', 'a', -1);
    return true;
  });
}
