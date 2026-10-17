// 鲸鲸阅读器渲染引擎：markdown-it 单例 + 标题 id + 图片相对路径改写 + GFM 扩展语法与代码高亮 + 出口清洗。
// 单例让 renderMarkdown 与 extractHeadings 对同一文档产生完全一致的标题 id（共用 slugify 分配逻辑）。
// Task 6 起装配脚注/任务清单/emoji 插件并自定义 fence 渲染器（代码高亮 + 复制按钮）；
// Task 7 起 renderMarkdown 出口统一过 sanitizeHtml（DOMPurify 白名单），内嵌 HTML 不再原样透传。

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';
import { highlight } from './highlight.js';
import { sanitizeHtml } from './sanitize.js';

/** env 中保存「本文档已占用标题 id」的键：每次渲染/提取用新 Set，保证同一文档的 id 稳定可复现。 */
const USED_IDS_KEY = '__jjHeadingUsedIds';

/** 绝对/特殊地址前缀：命中的图片 src 保持原样，其余相对路径才按 baseUrl 解析。 */
const ABSOLUTE_SRC_RE = /^(?:https?:\/\/|data:|#|mailto:|tel:)/i;

/** 保留字母（含中日韩）、数字与组合记号；其余标点/符号丢弃。 */
const SLUG_KEEP_RE = /[\p{L}\p{N}\p{M}]/u;

/** 空白（含全角空格）统一视为分隔符。 */
const SLUG_SPACE_RE = /\s/u;

/** 属性值转义映射（data-code 等属性必须整段转义，保证 dataset.code 能还原原始代码）。 */
const ATTR_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ATTR_ESCAPE_RE = /[&<>"']/g;

/** HTML 属性级转义：& < > " ' 全转（引号内的语言串/代码原样还原）。 */
function escapeAttr(text) {
  return String(text ?? '').replace(ATTR_ESCAPE_RE, (ch) => ATTR_ESCAPE_MAP[ch]);
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

// GFM 扩展语法（Task 6）：脚注、任务清单（只读 checkbox，不回写）、emoji 全量短码。
// 顺序放在核心规则/渲染器自定义之前，插件之间互不依赖；task-lists 只处理「列表项首字符 [ ]/[x]」。
md.use(footnote);
md.use(taskLists, { enabled: false, label: false });
md.use(emoji);

/**
 * 把 inline 子 token 还原成纯文本：去掉强调/链接/HTML 等行内标记，保留文字、行内代码、emoji 与图片 alt。
 * 注意标题 id 规则挂在 core 链末尾（text_join 之后），因此此时转义字符已合并回 text token。
 */
function inlinePlainText(children) {
  let text = '';
  for (const child of children || []) {
    switch (child.type) {
      case 'text':
      case 'code_inline':
        text += child.content;
        break;
      case 'emoji': // Task 6 起 emoji 是独立 token（content 就是 unicode 字符），标题文本不能丢字
        text += child.content;
        break;
      case 'image': // 图片在标题里按 alt 文本参与 id 计算
        text += inlinePlainText(child.children);
        break;
      case 'softbreak':
      case 'hardbreak':
        text += ' ';
        break;
      default: // 强调/链接/HTML 等标记 token 不贡献文本
        break;
    }
  }
  return text;
}

/**
 * 生成标题锚点 id：保留中日韩字符、字母与数字，空白转 '-'，标点与其它符号丢弃；
 * 连续 '-' 折叠、去掉首尾 '-'。传入 usedIds（Set）时登记并保证唯一：重复 id 依次加 -2、-3。
 */
export function slugify(text, usedIds) {
  let id = '';
  for (const ch of String(text ?? '')) {
    if (SLUG_KEEP_RE.test(ch)) {
      id += ch;
    } else if (SLUG_SPACE_RE.test(ch)) {
      id += '-';
    }
  }
  id = id.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  if (!usedIds || typeof usedIds.has !== 'function' || typeof usedIds.add !== 'function') {
    return id;
  }

  let unique = id;
  let suffix = 2;
  while (usedIds.has(unique)) {
    unique = `${id}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(unique);
  return unique;
}

// 标题 id：core 链末尾（inline/text_join 之后）给每个 heading_open 写 id。
// 放在单例上而不是每次 render 注册，保证 renderMarkdown 与 extractHeadings 走同一套分配逻辑。
md.core.ruler.push('jj_heading_id', (state) => {
  let usedIds = state.env && state.env[USED_IDS_KEY];
  if (!(usedIds instanceof Set)) {
    usedIds = new Set();
    if (state.env) {
      state.env[USED_IDS_KEY] = usedIds;
    }
  }
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'heading_open') {
      continue;
    }
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') {
      continue;
    }
    token.attrSet('id', slugify(inlinePlainText(inline.children), usedIds));
  }
});

// 图片相对路径改写：仅当 env.baseUrl 存在且 src 不是绝对/特殊地址时，按虚拟主机 baseUrl 解析。
// 包装默认 image renderer 而不是整段重写，保留 alt/title 等属性与转义行为。
const defaultImageRenderer = md.renderer.rules.image;

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src');
  const baseUrl = env && typeof env.baseUrl === 'string' ? env.baseUrl : '';
  if (baseUrl && src && !ABSOLUTE_SRC_RE.test(src)) {
    try {
      token.attrSet('src', new URL(src, baseUrl).href);
    } catch {
      // baseUrl 非法时保留原 src：图片显示不出来也不能让整篇渲染失败
    }
  }
  return defaultImageRenderer(tokens, idx, options, env, self);
};

// 代码围栏渲染（Task 6）：高亮 + 复制按钮。
// 固定结构：<div class="code-wrap"><pre><code class="hljs language-x">…</code></pre><button class="copy" data-code="…">复制</button></div>
// data-code 存原始代码（属性级转义，enhance.js 用 btn.dataset.code 取回）；高亮失败/未知语言时 highlight() 已降级为转义纯文本。
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  // info 形如 "js" 或 "js title=..."：只取第一个词当语言（与 markdown-it 默认 renderer 口径一致）
  const info = token.info ? token.info.trim() : '';
  const lang = info.split(/\s+/)[0] || '';
  const code = token.content;
  const highlighted = highlight(code, lang);
  const codeClass = lang ? `hljs language-${escapeAttr(lang)}` : 'hljs';
  return (
    `<div class="code-wrap"><pre><code class="${codeClass}">${highlighted}</code></pre>` +
    `<button class="copy" type="button" data-code="${escapeAttr(code)}">复制</button></div>\n`
  );
};

/**
 * 渲染 markdown 为 HTML 字符串。
 * env 可选 { baseUrl }：相对图片 src 按 baseUrl 解析；未给 baseUrl 时保留原样。
 * 出口统一过 sanitizeHtml（Task 7）：Markdown 内嵌 HTML 必须先经 DOMPurify 白名单才能进 DOM。
 */
export function renderMarkdown(markdown, env = {}) {
  // 拷贝一份 env 再挂内部状态：不污染调用方对象，同时让核心规则拿到本文档的 usedIds。
  const renderEnv = { ...env, [USED_IDS_KEY]: new Set() };
  return sanitizeHtml(md.render(String(markdown ?? ''), renderEnv));
}

/**
 * 提取标题列表 [{ id, text, level }]。
 * id 由同一套 slugify 分配逻辑生成，因此与 renderMarkdown 渲染出的 heading id 完全一致。
 */
export function extractHeadings(markdown) {
  const env = { [USED_IDS_KEY]: new Set() };
  const tokens = md.parse(String(markdown ?? ''), env);
  const headings = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'heading_open') {
      continue;
    }
    const inline = tokens[i + 1];
    headings.push({
      id: token.attrGet('id') || '',
      text: inline && inline.type === 'inline' ? inlinePlainText(inline.children) : '',
      level: Number(token.tag.slice(1)),
    });
  }
  return headings;
}
