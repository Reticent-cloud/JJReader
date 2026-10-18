// 代码高亮（Task 6）：highlight.js core 按需注册语言，未知语言降级为转义纯文本。
// 不使用 highlight.js 全量入口（190+ 语言，体积不可控），只注册围栏里常见的 15 种语言模块；
// 产物体积与注册语言数直接相关，加语言前先看 web/build.mjs 的 500 KB 门禁。

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** 注册名 → 语言定义模块（注册名是 hljs 的规范名，别名由模块自带 aliases 注册）。 */
const LANGUAGE_MODULES = {
  bash,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGE_MODULES)) {
  hljs.registerLanguage(name, definition);
}

/**
 * 常见围栏语言串 → 注册名。
 * hljs 模块自带的 aliases 已覆盖大部分（js/sh/yml/html…），这里把高频写法显式钉住，
 * 避免不同语言模块的 alias 表变化导致围栏语言突然降级。
 */
const LANGUAGE_ALIASES = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  cs: 'csharp',
  'c#': 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  md: 'markdown',
};

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** HTML 转义（文本与属性上下文通用）：兜底纯文本与围栏属性转义共用同一套映射。 */
function escapeHtml(text) {
  return String(text ?? '').replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/** 围栏语言串归一化：去空白、转小写，再按别名表映射到注册名；空串表示未标注语言。 */
function normalizeLanguage(lang) {
  const raw = String(lang ?? '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  return LANGUAGE_ALIASES[raw] || raw;
}

/**
 * 高亮一段代码，返回可直接插入 <code> 的 HTML。
 * 未给语言、语言未注册、或 hljs 抛错时降级为转义后的纯文本（绝不抛异常，保证渲染不中断）。
 * 成功时返回 hljs 的 <span class="hljs-…"> 片段（外层 class="hljs" 由围栏渲染器补）。
 */
export function highlight(code, lang) {
  const text = String(code ?? '');
  const language = normalizeLanguage(lang);
  if (!language) {
    return escapeHtml(text);
  }

  // getLanguage 对未注册语言返回 undefined（直接 highlight 会抛 "Unknown language"）。
  let definition;
  try {
    definition = hljs.getLanguage(language);
  } catch {
    definition = undefined;
  }
  if (!definition) {
    return escapeHtml(text);
  }

  try {
    return hljs.highlight(text, { language }).value;
  } catch {
    // 语言定义自身异常（理论上不该发生）：按纯文本降级，不能把整篇渲染拖崩。
    return escapeHtml(text);
  }
}
