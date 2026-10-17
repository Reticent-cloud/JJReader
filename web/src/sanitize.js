// 鲸鲸阅读器 HTML 清洗（Task 7）：Markdown 内嵌 HTML 一律经 DOMPurify 白名单后才进 DOM（spec §4.5.6）。
// 职责边界：只做安全过滤，不改写任何 URL（相对图片路径改写仍在 engine 的 image renderer 里）。
// 白名单覆盖渲染器实际产出与后续任务依赖的结构：复制按钮（button/data-code）、脚注（section/sup/a）、
// 任务清单（input/type/checked/disabled）、表格（table/th/td/style text-align）、[TOC]（nav/ol/li/data-level）、
// 笔记锚点（data-target），以及允许在 Markdown 里内嵌的良性 HTML（details/summary/kbd/sub/sup/mark/center/font 等）。

import createDOMPurify from 'dompurify';

/** 放行标签。不在列的一律剥掉：script/style/iframe/object/embed/form/textarea/meta/link/base… */
const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'center',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'kbd',
  'li',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'button',
];

/** 放行属性。data-* 只显式列三个跨任务约定键（ALLOW_DATA_ATTR:false 时其余 data-* 一律剥掉）。 */
const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'align',
  'width',
  'height',
  'colspan',
  'rowspan',
  'class',
  'id',
  'start',
  'type',
  'checked',
  'disabled',
  'loading',
  'rel',
  'target',
  'open',
  'style',
  'data-target',
  'data-level',
  'data-code',
];

/**
 * 这三个 data-* 存的是任意文本（代码/层级/目标）而不是 URL，必须登记为「URI 安全属性」；
 * 否则 data-code 里出现形如 `key: value` 的代码时会被 DOMPurify 的 URI 规则整条误删。
 */
const URI_SAFE_DATA_ATTRS = ['data-code', 'data-level', 'data-target'];

/** style 属性只保留这些声明；position/display/behavior 等其余声明一律剥离。 */
const ALLOWED_STYLE_PROPS = new Set([
  'text-align',
  'font-family',
  'font-size',
  'font-weight',
  'color',
  'background',
  'background-color',
  'max-width',
  'width',
  'height',
]);

/** style 值里的危险关键字（CSS 表达式/脚本协议）：命中即剥离该条声明。 */
const UNSAFE_STYLE_VALUE_RE = /(?:expression|javascript|vbscript)\s*[:(]/i;

/**
 * 与 HTML 属性值空白归一化口径一致（和 DOMPurify 内部的 ATTR_WHITESPACE 同款字符集）。
 * 导出仅为直接单测（测试评审 must-fix：混淆变体要能单独锁定归一化字符集）。
 */
export const URL_WHITESPACE_RE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

const DATA_IMAGE_RE = /^data:image\//i;
const DATA_ANY_RE = /^data:/i;

/**
 * 允许的协议 + 无协议相对地址/片段。口径对齐 DOMPurify 默认相对地址规则（首字符非字母，
 * 或「字母段 + 非 scheme 字符」），但协议只收 http/https/mailto/tel，移除 ftp/callto/xmpp 等。
 */
const SAFE_URL_RE = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** 同上，额外放行 data:image/（仅在 allowDataImages 时用作 DOMPurify 的 ALLOWED_URI_REGEXP）。 */
const SAFE_URL_WITH_DATA_IMAGE_RE =
  /^(?:(?:https?|mailto|tel):|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** href/src 会做协议校验的属性名（其余属性不碰）；事件处理属性等未列名属性由 DOMPurify 按白名单剥掉。 */
const URL_ATTRS = new Set(['href', 'src']);

/**
 * URL 是否安全：允许 http(s)/mailto/tel、data:image（受 allowDataImages 控制）以及无协议相对地址/片段；
 * 移除 javascript:/vbscript:/file:/data:text/html 等其它协议。只看安全，不改写原值。
 * 导出仅为直接单测（大小写/实体/空白/协议相对等混淆变体）。
 */
export function isSafeUrl(value, allowDataImages) {
  const normalized = String(value ?? '').replace(URL_WHITESPACE_RE, '');
  if (normalized === '') {
    return true;
  }
  if (DATA_IMAGE_RE.test(normalized)) {
    return allowDataImages;
  }
  if (DATA_ANY_RE.test(normalized)) {
    return false;
  }
  return SAFE_URL_RE.test(normalized);
}

/**
 * 按顶层分号切分 CSS 声明：括号/引号内的分号不切（background:url(data:...;base64,...) 不能被切坏）。
 * @returns {string[]} 原始声明片段（未 trim）
 */
function splitStyleDeclarations(css) {
  const declarations = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      declarations.push(css.slice(start, i));
      start = i + 1;
    }
  }
  declarations.push(css.slice(start));
  return declarations;
}

/**
 * 过滤 style 声明：只留白名单属性，剥掉 expression()/javascript: 等危险值。
 * 未发生过滤时返回原串（保证 markdown-it 表格的 style="text-align:center" 原样不变）；
 * 全部剥离时返回空串（调用方据此删除 style 属性）。
 */
function filterStyle(css) {
  const text = String(css ?? '');
  const kept = [];
  let filtered = false;
  for (const raw of splitStyleDeclarations(text)) {
    const declaration = raw.trim();
    if (!declaration) {
      continue;
    }
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      filtered = true;
      continue;
    }
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop) || !value || UNSAFE_STYLE_VALUE_RE.test(value)) {
      filtered = true;
      continue;
    }
    kept.push(declaration);
  }
  if (!filtered) {
    return text;
  }
  return kept.join(';');
}

/** 逐元素过滤 style 属性；全剥时连 style 属性一起删。 */
function filterStyleAttribute(node) {
  if (!node.hasAttribute('style')) {
    return;
  }
  const original = node.getAttribute('style');
  const filtered = filterStyle(original);
  if (filtered === original) {
    return;
  }
  if (filtered === '') {
    node.removeAttribute('style');
  } else {
    node.setAttribute('style', filtered);
  }
}

/**
 * 逐元素校验 href/src 协议并删除不安全地址。
 * DOMPurify 自身已按 ALLOWED_URI_REGEXP 过滤，但 <img src="data:..."> 会走它的 data-URI 例外路径，
 * 这里统一兜底：只有 allowDataImages 且确实是 data:image/ 才放行。
 */
function filterUrlAttributes(node, allowDataImages) {
  const { attributes } = node;
  if (!attributes) {
    return;
  }
  for (let i = attributes.length - 1; i >= 0; i -= 1) {
    const attr = attributes[i];
    const name = attr.name.toLowerCase();
    if (!URL_ATTRS.has(name)) {
      continue;
    }
    if (!isSafeUrl(attr.value, allowDataImages)) {
      node.removeAttribute(attr.name);
    }
  }
}

/** afterSanitizeAttributes hook：属性名/标签白名单已由 DOMPurify 处理，这里补值级规则（协议 + style）。 */
function hardenAttributes(node, allowDataImages) {
  if (!node || node.nodeType !== 1) {
    return;
  }
  filterStyleAttribute(node);
  filterUrlAttributes(node, allowDataImages);
}

/**
 * uponSanitizeAttribute hook：data-code/data-level/data-target 存任意文本，强制保留原属性值。
 * DOMPurify 默认会 trim 属性值（会吃掉代码结尾换行）并做 XML 安全值检查（代码里出现 </script> 会整条删），
 * forceKeepAttr 让复制按钮拿到的代码与原文一字不差。
 */
function keepDataAttributeValue(node, data) {
  if (data && URI_SAFE_DATA_ATTRS.includes(data.attrName)) {
    data.forceKeepAttr = true;
  }
}

/** fail-closed 告警只打一次（DOMPurify 在当前环境不可用时避免每次渲染刷屏）。 */
let unsupportedWarned = false;

/** DOMPurify 工厂（测试可注入 isSupported=false 的桩；产品默认使用真实实现）。 */
let purifierFactory = createDOMPurify;

/**
 * 测试专用：替换 DOMPurify 工厂并清空缓存实例（不传函数时恢复默认）。
 * 仅用于验证 isSupported=false 的失败关闭行为；产品代码不要调用。
 * @param {Function | null} factory
 */
export function __setPurifierFactoryForTest(factory) {
  purifierFactory = typeof factory === 'function' ? factory : createDOMPurify;
  purifiers.clear();
  unsupportedWarned = false;
}

/** 按 allowDataImages 缓存两个清洗实例（hook 闭包捕获配置，避免共享可变状态；清洗是同步的，天然可重入）。 */
const purifiers = new Map();

function getPurifier(allowDataImages) {
  const key = allowDataImages ? 'data-image' : 'strict';
  if (purifiers.has(key)) {
    return purifiers.get(key);
  }
  const win = globalThis.window;
  if (!win) {
    // 非浏览器环境（无 DOM）：不装配清洗器，sanitizeHtml 返回空串（安全侧失败，绝不透传未清洗 HTML）
    return null;
  }
  const instance = purifierFactory(win);
  // 修复波 B-I5（fail-open）：DOMPurify 在当前环境不受支持时 sanitize 会原样返回输入（等于不清洗）。
  // 这里显式失败关闭：返回空串，首次记录一条 console.warn 便于排查。
  if (!instance || instance.isSupported === false) {
    if (!unsupportedWarned) {
      unsupportedWarned = true;
      try {
        console.warn('[JJ] DOMPurify 在当前环境不可用，HTML 清洗已失败关闭（输出空串）');
      } catch {
        // 无 console 环境忽略
      }
    }
    return null;
  }
  instance.addHook('uponSanitizeAttribute', keepDataAttributeValue);
  instance.addHook('afterSanitizeAttributes', (node) => hardenAttributes(node, allowDataImages));
  purifiers.set(key, instance);
  return instance;
}

/**
 * 清洗一段 HTML 字符串：DOMPurify 白名单（标签/属性/协议）+ style 声明过滤。
 * @param {string} html 待清洗 HTML（非字符串返回空串，绝不抛异常）
 * @param {{allowDataImages?: boolean}} [options] allowDataImages=false 时连 data:image 也不放行
 * @returns {string} 清洗后的 HTML
 */
export function sanitizeHtml(html, { allowDataImages = true } = {}) {
  if (typeof html !== 'string') {
    return '';
  }
  const enableDataImages = allowDataImages !== false;
  const purifier = getPurifier(enableDataImages);
  if (!purifier) {
    return '';
  }
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // 其余 data-*、aria-* 一律不放行（三个跨任务 data-* 已在 ALLOWED_ATTR/ADD_URI_SAFE_ATTR 显式登记）
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: enableDataImages ? SAFE_URL_WITH_DATA_IMAGE_RE : SAFE_URL_RE,
    ADD_URI_SAFE_ATTR: URI_SAFE_DATA_ATTRS,
    RETURN_DOM_FRAGMENT: false,
    // 输出只进 HTML 的 innerHTML，不进入 XML 序列化：关闭 XML 专用 mXSS 值检查，
    // 否则 data-code 里出现 </script>、</style> 等代码文本时属性会被整条删掉（复制按钮失效）。
    // 标签/属性白名单 + 协议白名单 + style 过滤仍是主防线。
    SAFE_FOR_XML: false,
  });
}
