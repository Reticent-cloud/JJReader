// 排版设置（Task 10）：字号 14–24（默认 16）、行距 1.4–2.0（默认 1.7）、行宽 640/780/960/全宽（默认 780，0 表示全宽）、
// 中文字体与代码字体；配色维度 palette（default 中性灰蓝 / blue 鲸鱼蓝，默认 blue）。
// applySettings 把设置夹紧后写 CSS 变量（base.css/layout.css/code.css 读取）并写 html[data-palette]，
// settingsPatch 只返回变化字段（saveSettings{patch} 契约：前端只报变化，宿主合并后写 settings.json）。

import { normalizeTheme } from './theme.js';

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 16;

export const LINE_HEIGHT_MIN = 1.4;
export const LINE_HEIGHT_MAX = 2.0;
export const LINE_HEIGHT_DEFAULT = 1.7;

/** 合法行宽档位（px）；0 = 全宽（CSS 100%）。 */
export const CONTENT_WIDTHS = [640, 780, 960];
export const CONTENT_WIDTH_DEFAULT = 780;
export const CONTENT_WIDTH_FULL = 0;

export const TOC_WIDTH_MIN = 180;
export const TOC_WIDTH_MAX = 360;
export const TOC_WIDTH_DEFAULT = 240;

/** 配色维度（palette）合法值：default = 中性（默认，正文纯白），blue = 鲸鱼蓝。 */
export const PALETTES = ['default', 'blue'];

/** 默认配色：中性「默认」（用户要求首次打开/浅色主题为白色；鲸鱼蓝为可选项）。 */
export const PALETTE_DEFAULT = 'default';

/** 配色偏好：缺省/非法一律回落 default（与宿主 AppSettings.Palette 默认值一致）。 */
export function normalizePalette(palette) {
  return palette === 'blue' ? 'blue' : PALETTE_DEFAULT;
}

/** 系统默认中文字体栈（spec §5.5：Segoe UI + 微软雅黑）。 */
export const SYSTEM_CJK_STACK = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif";

/** 代码字体栈尾部兜底（monoFont 值作为前缀，缺失字体时仍回落到等宽字体）。 */
export const MONO_FALLBACK_STACK = "'Cascadia Mono', monospace";

/** 设置对象默认值（与宿主 AppSettings / settings.json 的 camelCase 字段一致）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  fontSize: FONT_SIZE_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
  contentWidth: CONTENT_WIDTH_DEFAULT,
  cjkFont: 'system',
  monoFont: 'consolas',
  tocVisible: true,
  tocWidth: TOC_WIDTH_DEFAULT,
  palette: PALETTE_DEFAULT,
});

/** 转有限数字；非数字/NaN/Infinity/空串返回 null。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 字号：整数 + 夹紧到 [14,24]，非法值回落默认 16。 */
export function normalizeFontSize(value) {
  const number = toFiniteNumber(value);
  if (number === null) {
    return FONT_SIZE_DEFAULT;
  }
  return Math.round(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, number)));
}

/** 行距：夹紧到 [1.4,2.0]（保留两位小数），非法值回落默认 1.7。 */
export function normalizeLineHeight(value) {
  const number = toFiniteNumber(value);
  const clamped =
    number === null ? LINE_HEIGHT_DEFAULT : Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, number));
  return Math.round(clamped * 100) / 100;
}

/** 行宽：0 表示全宽；其余值取最近合法档（640/780/960），非法值回落 780。 */
export function normalizeContentWidth(value) {
  const number = toFiniteNumber(value);
  if (number === null) {
    return CONTENT_WIDTH_DEFAULT;
  }
  if (number === CONTENT_WIDTH_FULL) {
    return CONTENT_WIDTH_FULL;
  }
  let best = CONTENT_WIDTH_DEFAULT;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const width of CONTENT_WIDTHS) {
    const distance = Math.abs(number - width);
    if (distance < bestDistance) {
      best = width;
      bestDistance = distance;
    }
  }
  return best;
}

/** 侧栏宽度：夹紧到 [180,360]（拖拽在后续任务，本任务先保证持久化值合法）。 */
export function normalizeTocWidth(value) {
  const number = toFiniteNumber(value);
  if (number === null) {
    return TOC_WIDTH_DEFAULT;
  }
  return Math.round(Math.min(TOC_WIDTH_MAX, Math.max(TOC_WIDTH_MIN, number)));
}

/** 字体名清洗：去掉可能破坏 CSS 值的字符（分号/花括号/尖括号/反斜杠/引号），空值回落默认。 */
function sanitizeFontName(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/[;{}<>\\"]/g, '').trim() : '';
  return text === '' ? fallback : text;
}

/** 字体偏好：非空字符串原样保留（'system' 是合法值），非法值回落默认。 */
function normalizeFontPreference(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? fallback : text;
}

/**
 * 把任意设置对象归一为合法值（缺失字段用默认值）。
 * shell 的 state.settings 与 applySettings 的写入值都经过这里，保证 patch 比较的是同一套归一值。
 */
export function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    theme: normalizeTheme(source.theme),
    fontSize: normalizeFontSize(source.fontSize),
    lineHeight: normalizeLineHeight(source.lineHeight),
    contentWidth: normalizeContentWidth(source.contentWidth),
    cjkFont: normalizeFontPreference(source.cjkFont, DEFAULT_SETTINGS.cjkFont),
    monoFont: normalizeFontPreference(source.monoFont, DEFAULT_SETTINGS.monoFont),
    tocVisible: source.tocVisible !== false,
    tocWidth: normalizeTocWidth(source.tocWidth),
    palette: normalizePalette(source.palette),
  };
}

/** 中文字体 CSS 值：system 用系统栈；自定义字体名作为 font-family 前缀，后面仍接系统栈兜底。 */
function cjkFontValue(font) {
  const name = sanitizeFontName(font, '');
  if (!name || name === 'system') {
    return SYSTEM_CJK_STACK;
  }
  return `${name}, ${SYSTEM_CJK_STACK}`;
}

/** 代码字体 CSS 值：monoFont 作为前缀，后接等宽字体兜底。 */
function monoFontValue(font) {
  const name = sanitizeFontName(font, '');
  if (!name || name === 'system') {
    return `consolas, ${MONO_FALLBACK_STACK}`;
  }
  return `${name}, ${MONO_FALLBACK_STACK}`;
}

/**
 * 把设置夹紧后写入根元素 CSS 变量：
 * --font-size（px）、--line-height（无单位）、--content-width（px 或 100%）、--font-cjk、--font-mono、
 * --toc-width（px，TOC 侧栏宽；normalizeSettings 已夹紧 180–360，拖拽调宽实时走这里）；
 * 以及 html[data-palette]（配色维度，与 data-theme 正交）。
 * 非浏览器环境（无 document）直接跳过，绝不抛异常。
 */
export function applySettings(settings) {
  const normalized = normalizeSettings(settings);
  const doc = globalThis.document;
  const style = doc && doc.documentElement ? doc.documentElement.style : null;
  if (!style) {
    return;
  }
  style.setProperty('--font-size', `${normalized.fontSize}px`);
  style.setProperty('--line-height', String(normalized.lineHeight));
  style.setProperty(
    '--content-width',
    normalized.contentWidth === CONTENT_WIDTH_FULL ? '100%' : `${normalized.contentWidth}px`,
  );
  style.setProperty('--font-cjk', cjkFontValue(normalized.cjkFont));
  style.setProperty('--font-mono', monoFontValue(normalized.monoFont));
  style.setProperty('--toc-width', `${normalized.tocWidth}px`);
  // 配色维度与 data-theme（light/dark）正交：CSS 用 html[data-palette='default'] 覆盖 chrome 变量。
  doc.documentElement.dataset.palette = normalized.palette;
}

/**
 * 只返回 next 相对 current 变化的顶层字段（Object.is 比较；布尔 false 也算变化）。
 * 用于 saveSettings 的部分更新：前端只报差异，宿主合并后落盘。
 */
export function settingsPatch(current, next) {
  const base = current && typeof current === 'object' ? current : {};
  const target = next && typeof next === 'object' ? next : {};
  const patch = {};
  for (const key of Object.keys(target)) {
    if (!Object.is(base[key], target[key])) {
      patch[key] = target[key];
    }
  }
  return patch;
}
