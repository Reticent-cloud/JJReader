// 界面风格（主题之外的第二个视觉维度）：reader（阅读器风，默认）/ whale（鲸鱼娘主题）。
// 只写 html[data-ui-style]，不碰布局结构与交互；配色与装饰由 web/src/styles/overrides-*.css 读取。
// 未知值一律回退 reader（settings.json 可能被手改或来自旧版本）。

/** 合法界面风格（顺序即 Aa 面板下拉顺序）。 */
export const UI_STYLES = ['reader', 'whale'];

/** 默认界面风格（与宿主 AppSettings.UiStyle 默认值一致）。 */
export const UI_STYLE_DEFAULT = 'reader';

/** 中文标签（工具条按钮 title / Aa 面板下拉）。 */
const UI_STYLE_LABELS = {
  reader: '阅读器风',
  whale: '鲸鱼娘',
};

/** 归一化：只接受 whale，其余（含 undefined / null / 未知字符串）都回退 reader。 */
export function normalizeUiStyle(style) {
  return style === 'whale' ? 'whale' : UI_STYLE_DEFAULT;
}

/** 两态循环：reader ↔ whale（工具条「🐳 主题」按钮用）。 */
export function nextUiStyle(style) {
  return normalizeUiStyle(style) === 'whale' ? 'reader' : 'whale';
}

/** 风格中文名：阅读器风 / 鲸鱼娘。 */
export function uiStyleLabel(style) {
  return UI_STYLE_LABELS[normalizeUiStyle(style)];
}

/**
 * 把界面风格写到根元素 data-ui-style，返回实际生效的合法值。
 * 非浏览器环境（无 document）也安全返回归一值，绝不抛异常。
 * @param {'reader'|'whale'|string} style
 * @returns {'reader'|'whale'}
 */
export function applyUiStyle(style) {
  const resolved = normalizeUiStyle(style);
  const doc = globalThis.document;
  if (doc && doc.documentElement) {
    doc.documentElement.setAttribute('data-ui-style', resolved);
  }
  return resolved;
}
