// 附件扩展（Task 8）：![[文件]] / ![[文件|别名]]。
// 扩展名属于图片集（png/jpg/jpeg/gif/webp/svg/bmp/avif，大小写不敏感）→ markdown-it image token：
//   src 保持相对路径原样，交给 engine 的图片 renderer 按 env.baseUrl 改成虚拟主机地址；class="attachment"。
// 其它类型 → <a class="attachment" data-target="文件">文件</a>，由 T13 的 enhance 绑定点击寻文件。
// 别名口径（brief 未定，Controller 授权自定）：图片别名作 alt，非图片别名作链接文本；缺省都用文件名。
// 空目标 ![[ ]] 按原样文本输出。
import { splitBracketed } from './util.js';

/** 图片附件判定：只看扩展名（扩展名集合按任务书固定，大小写不敏感）。 */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function install(md) {
  md.inline.ruler.before('link', 'jj_attachment', (state, silent) => {
    const { src } = state;
    const start = state.pos;
    if (
      src.charCodeAt(start) !== 0x21 /* ! */ ||
      src.charCodeAt(start + 1) !== 0x5b /* [ */ ||
      src.charCodeAt(start + 2) !== 0x5b /* [ */
    ) {
      return false;
    }
    const parsed = splitBracketed(src, start + 1, state.posMax);
    if (!parsed || !parsed.target) {
      return false;
    }
    const file = parsed.target;
    const label = parsed.alias || file;
    const isImage = IMAGE_EXT_RE.test(file);
    // 非图片附件会生成 <a>：链接文本内不再嵌套 <a>，按原样文本输出（图片附件仍允许放在链接里）。
    if (silent) {
      state.pos = parsed.end;
      return true;
    }
    if (!isImage && state.linkLevel > 0) {
      return false;
    }
    state.pos = parsed.end;
    if (isImage) {
      const image = state.push('image', 'img', 0);
      image.attrs = [
        ['src', file],
        ['alt', label],
      ];
      image.attrSet('class', 'attachment');
      // 与 markdown-it image 规则一致：children 供默认 renderer 生成 alt（renderInlineAsText）。
      const alt = new state.Token('text', '', 0);
      alt.content = label;
      image.children = [alt];
      image.content = label;
    } else {
      const open = state.push('link_open', 'a', 1);
      open.attrs = [
        ['class', 'attachment'],
        ['data-target', file],
      ];
      state.push('text', '', 0).content = label;
      state.push('link_close', 'a', -1);
    }
    return true;
  });
}
