// shell 总装：固定 DOM 骨架、消息分发、正文渲染与 renderDone 回报。
// 正文走 JJ.renderMarkdown（Task 5 起为 markdown-it 引擎），引擎缺失时降级 escapeHtml + <pre> 保证不白屏。
// Task 10 起装配阅读体验：TOC 侧栏（标题 id 兜底 + 滚动联动）、主题三态、排版面板（Aa）与快捷键。
// 设计约束：所有设置变更「先应用再上报」——applySettings/applyTheme 同步写 CSS 变量，随后 post('saveSettings', {patch})，
// 只发变化字段（宿主合并后落盘）；任何一步失败都不能影响正文渲染。

import { applySettings, DEFAULT_SETTINGS, normalizeSettings, settingsPatch } from '../settings.js';
import { applyTheme, nextTheme } from '../theme.js';
import {
  buildToc,
  createScrollSpy,
  readHeadingLevel,
  readHeadingTop,
  TOC_TOOLBAR_OFFSET,
} from '../toc.js';

/** 全局唯一的时间源：优先高精度计时，缺失时退回 Date.now。 */
function now() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/** HTML 文本转义（仅引擎缺失时的兜底渲染用；正常正文由 renderMarkdown 输出，T7 统一加 DOMPurify 清洗）。 */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 文本的 UTF-8 字节数（renderDone.bytes 用；手写计数，不依赖 TextEncoder 是否存在）。 */
function utf8Length(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) {
    const codePoint = ch.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// 工具条按钮：全部用 DOM API 创建（不拼 HTML），统一的 class/title 便于 CSS 与可访问性。
function createToolbarButton(label, id, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool';
  button.id = id;
  if (title) {
    button.title = title;
  }
  button.textContent = label;
  return button;
}

// Aa 面板的行/档位定义（与 spec §5.5 口径一致；行宽 0 = 全宽）。
const WIDTH_OPTIONS = [
  { value: '640', label: '640' },
  { value: '780', label: '780' },
  { value: '960', label: '960' },
  { value: '0', label: '全宽' },
];

const CJK_FONT_OPTIONS = [
  { value: 'system', label: '系统默认' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'Source Han Sans SC', label: '思源黑体' },
];

const MONO_FONT_OPTIONS = [
  { value: 'consolas', label: 'Consolas' },
  { value: 'Cascadia Mono', label: 'Cascadia Mono' },
];

/** 带数值回显的滑杆行（字号/行距）。 */
function createRangeRow(labelText, setting, min, max, step, value) {
  const row = document.createElement('label');
  row.className = 'aa-row';
  const text = document.createElement('span');
  text.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.setting = setting;
  const output = document.createElement('output');
  output.className = 'aa-value';
  output.textContent = String(value);
  row.append(text, input, output);
  return row;
}

/** 下拉选择行（行宽/字体）。 */
function createSelectRow(labelText, setting, options, value) {
  const row = document.createElement('label');
  row.className = 'aa-row';
  const text = document.createElement('span');
  text.textContent = labelText;
  const select = document.createElement('select');
  select.dataset.setting = setting;
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    select.append(item);
  }
  select.value = value;
  row.append(text, select);
  return row;
}

/** 轻量排版 popover（字号/行距/行宽/中文字体/代码字体），默认隐藏。 */
function buildAaPanel() {
  const panel = document.createElement('div');
  panel.id = 'aa-panel';
  panel.className = 'aa-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '排版');
  panel.append(
    createRangeRow('字号', 'fontSize', 14, 24, 1, 16),
    createRangeRow('行距', 'lineHeight', 1.4, 2.0, 0.1, 1.7),
    createSelectRow('行宽', 'contentWidth', WIDTH_OPTIONS, '780'),
    createSelectRow('中文字体', 'cjkFont', CJK_FONT_OPTIONS, 'system'),
    createSelectRow('代码字体', 'monoFont', MONO_FONT_OPTIONS, 'consolas'),
  );
  return panel;
}

/** 主题按钮文案（三态各一个中文标签）。 */
function themeLabel(theme) {
  switch (theme) {
    case 'light':
      return '浅色';
    case 'dark':
      return '深色';
    default:
      return '跟随系统';
  }
}

/** 目标元素是否是可编辑控件（输入框/下拉/可编辑区）：这些控件内的快捷键交还给控件本身。 */
function isEditableTarget(target) {
  if (!target || target.nodeType !== 1) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null;
}

/**
 * 在 root（宿主页面的 #app）里装配 shell，返回 { root, onMessage, destroy }。
 * post(type, payload) 由调用方注入：浏览器环境走 window.chrome.webview.postMessage，
 * 测试传收集器。mountShell 完成后立即发一次 shellReady（宿主收到后才推送 load，
 * 避免 PostWebMessageAsJson 在页面监听器就绪前丢失）。
 */
export function mountShell({ root, post } = {}) {
  if (!root) {
    throw new Error('mountShell: 缺少 root 容器');
  }
  const send = typeof post === 'function' ? post : () => {};

  // 固定骨架：#app > header#toolbar、aside#toc、main#content（滚动容器）、div#aa-panel、div#toast
  root.replaceChildren();
  const toolbar = document.createElement('header');
  toolbar.id = 'toolbar';
  const toc = document.createElement('aside');
  toc.id = 'toc';
  toc.setAttribute('aria-label', '大纲');
  const content = document.createElement('main');
  content.id = 'content';
  const aaPanel = buildAaPanel();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.hidden = true;
  root.append(toolbar, toc, content, aaPanel, toast);

  const tocToggle = createToolbarButton('目录', 'toc-toggle', '大纲（Ctrl+B）');
  const themeToggle = createToolbarButton('跟随系统', 'theme-toggle', '主题：浅色 → 深色 → 跟随系统');
  const aaToggle = createToolbarButton('Aa', 'aa-toggle', '排版设置（Ctrl+,）');
  aaToggle.setAttribute('aria-expanded', 'false');
  aaToggle.setAttribute('aria-controls', 'aa-panel');
  const toolbarSpacer = document.createElement('div');
  toolbarSpacer.className = 'toolbar-spacer';
  toolbar.append(tocToggle, toolbarSpacer, themeToggle, aaToggle);

  const state = {
    path: '',
    key: '',
    baseUrl: '',
    settings: normalizeSettings(DEFAULT_SETTINGS),
    position: null,
    assoc: null,
    dirListing: null,
    // TOC 数据 = 渲染后 DOM 中的实际标题（顺序/文本从 DOM 取），元素带 { id, text, level, top }
    headings: [],
    spy: null,
    activeLink: null,
    // 最近一次 extractHeadings 的标题数（renderDone.tocCount 复用，避免为统计再多 parse 一次）
    extractedCount: 0,
  };

  /**
   * front matter「属性」折叠块（Task 9）：先用 JJ.extractFrontmatter 取本文档属性数据
   * （T8 carry-forward：不复用 renderMarkdown 写回的 env，避免跨文档陈旧），非空时在 #content 顶部插入
   * <details class="frontmatter"><summary>属性</summary><table>…</table></details>（默认折叠）。
   * 表格用 createElement/textContent 逐格写入：属性值是不可信文本，绝不拼 HTML 字符串。
   */
  function mountFrontmatter(markdown) {
    const engine = globalThis.JJ;
    if (!engine || typeof engine.extractFrontmatter !== 'function') {
      return;
    }
    const result = engine.extractFrontmatter(markdown);
    const data = result && typeof result === 'object' ? result.data : null;
    if (!data || typeof data !== 'object') {
      return;
    }
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return;
    }

    const details = document.createElement('details');
    details.className = 'frontmatter';
    const summary = document.createElement('summary');
    summary.textContent = '属性';
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    for (const [key, value] of entries) {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = String(key);
      const td = document.createElement('td');
      // 数组值用「、」连接；布尔/数字统一按字符串展示（与 extractFrontmatter 的解析口径一致）
      td.textContent = Array.isArray(value)
        ? value.map((item) => String(item)).join('、')
        : String(value);
      row.append(th, td);
      tbody.append(row);
    }
    table.append(tbody);
    details.append(summary, table);
    content.prepend(details);
  }

  /**
   * 标题 id 兜底（Task 10 关键）：DOMPurify 会剥掉与 DOM 同名的 id（title/body/form/constructor…），
   * 因此渲染后必须按 extractHeadings 的顺序把缺失/为空的 id 重新赋回（属性级兜底，不是只改提取列表）。
   * 配对口径：按 DOM 顺序 + 文本匹配（原始 HTML 标题不在 extractHeadings 里，不能按索引硬配）；
   * 实在配不上（纯标点标题等空 slug）时生成 section-N 兜底 id。TOC 数据一律取自渲染后的 DOM。
   * @returns {{id: string, text: string, level: number, top: number}[]}
   */
  function assignHeadingIds(markdown) {
    const elements = content.querySelectorAll('h1, h2, h3, h4, h5, h6');

    const engine = globalThis.JJ;
    let extracted = [];
    if (engine && typeof engine.extractHeadings === 'function') {
      const parsed = engine.extractHeadings(markdown);
      if (Array.isArray(parsed)) {
        extracted = parsed;
      }
    }
    // renderDone.tocCount 复用这次提取结果（T9 carry-forward：不为统计再 parse 一遍）
    state.extractedCount = extracted.length;
    if (elements.length === 0) {
      return [];
    }
    const slugify = engine && typeof engine.slugify === 'function' ? engine.slugify : null;

    // 已占用的 id：来自清洗后仍保留 id 的标题（重赋前先登记，避免兜底生成撞车）。
    const used = new Set();
    for (const element of elements) {
      if (element.id) {
        used.add(element.id);
      }
    }

    function fallbackId(headings) {
      let suffix = headings.length + 1;
      let candidate = `section-${suffix}`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `section-${suffix}`;
      }
      return candidate;
    }

    const headings = [];
    let cursor = 0;
    for (const element of elements) {
      const text = (element.textContent || '').trim();
      let id = element.id;
      if (id) {
        // 已有 id：把 extractHeadings 游标推进到同名项之后，保持顺序配对（原始 HTML 标题会自然跳过）
        for (let i = cursor; i < extracted.length; i += 1) {
          const candidate = extracted[i];
          if (candidate && typeof candidate === 'object' && candidate.id === id) {
            cursor = i + 1;
            break;
          }
        }
      } else {
        // 缺失 id：按顺序找文本一致、id 非空且未被占用的提取项（title/body 等被清洗剥掉的情形）
        let matched = -1;
        for (let i = cursor; i < extracted.length; i += 1) {
          const candidate = extracted[i];
          if (!candidate || typeof candidate !== 'object') {
            continue;
          }
          if (
            typeof candidate.id === 'string' &&
            candidate.id !== '' &&
            !used.has(candidate.id) &&
            String(candidate.text ?? '').trim() === text
          ) {
            matched = i;
            break;
          }
        }
        if (matched >= 0) {
          id = extracted[matched].id;
          cursor = matched + 1;
        } else if (slugify) {
          id = slugify(text, used) || fallbackId(headings);
        } else {
          id = fallbackId(headings);
        }
        element.id = id;
      }
      used.add(id);
      headings.push({
        id,
        text,
        level: readHeadingLevel(element),
        top: readHeadingTop(element),
      });
    }
    return headings;
  }

  /** 高亮 TOC 中当前标题的链接（aria-current 同步，供键盘/读屏识别）。 */
  function highlightToc(heading) {
    const links = toc.querySelectorAll('nav.toc a');
    let current = null;
    for (const link of links) {
      if (link.getAttribute('href') === `#${heading.id}`) {
        current = link;
        break;
      }
    }
    if (!current) {
      return;
    }
    if (state.activeLink && state.activeLink !== current) {
      state.activeLink.classList.remove('active');
      state.activeLink.removeAttribute('aria-current');
    }
    current.classList.add('active');
    current.setAttribute('aria-current', 'true');
    state.activeLink = current;
  }

  /** 重建 TOC 与滚动联动（无标题时显示空态提示，不创建 spy）。 */
  function renderToc(headings) {
    state.headings = headings;
    state.activeLink = null;
    if (state.spy) {
      state.spy.destroy();
      state.spy = null;
    }
    toc.replaceChildren(buildToc(headings));
    if (headings.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'toc-empty';
      empty.textContent = '此文档没有标题';
      toc.append(empty);
      return;
    }
    state.spy = createScrollSpy({
      scroller: content,
      headings,
      onActive: (heading) => highlightToc(heading),
      thresholdPx: TOC_TOOLBAR_OFFSET,
    });
    state.spy.update();
  }

  /** 主题：写 data-theme（system 跟随系统）并同步按钮文案。 */
  function applyThemeState() {
    const resolved = applyTheme(state.settings.theme);
    const label = themeLabel(state.settings.theme);
    themeToggle.textContent = label;
    themeToggle.setAttribute('aria-label', `主题：${label}（点击切换）`);
    themeToggle.title = `主题：${label}（点击循环：浅色 → 深色 → 跟随系统）`;
    return resolved;
  }

  /** 侧栏显隐：CSS 用 #app[data-toc="hidden"] 折叠（保持 DOM，切回不重建 TOC）。 */
  function applyTocVisibility() {
    const visible = state.settings.tocVisible;
    root.setAttribute('data-toc', visible ? 'visible' : 'hidden');
    tocToggle.setAttribute('aria-pressed', String(visible));
    tocToggle.classList.toggle('active', visible);
  }

  /** Aa 面板控件回显当前设置（快捷键改字号后滑杆同步）。 */
  function syncAaControls() {
    for (const control of aaPanel.querySelectorAll('[data-setting]')) {
      const key = control.dataset.setting;
      const value = state.settings[key];
      if (value === undefined) {
        continue;
      }
      control.value = String(value);
      const output = control.parentElement ? control.parentElement.querySelector('.aa-value') : null;
      if (output) {
        output.textContent = String(value);
      }
    }
  }

  /** 面板控件值 → 设置字段类型（滑杆给字符串，设置比较要数值）。 */
  function coerceSettingValue(key, raw) {
    if (key === 'fontSize') {
      return Math.round(Number(raw));
    }
    if (key === 'lineHeight' || key === 'contentWidth') {
      return Number(raw);
    }
    return String(raw);
  }

  /**
   * 唯一设置入口：归一 → 只算变化字段 → 先应用（写 CSS 变量/主题/侧栏）→ 再上报 saveSettings{patch}。
   * 没有变化时什么都不做（不重复发消息）。
   * @returns {object} 实际发送的 patch（无变化为空对象）
   */
  function updateSettings(next) {
    const merged = normalizeSettings({ ...state.settings, ...(next && typeof next === 'object' ? next : {}) });
    const patch = settingsPatch(state.settings, merged);
    if (Object.keys(patch).length === 0) {
      return {};
    }
    state.settings = merged;
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      applyThemeState();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'tocVisible')) {
      applyTocVisibility();
    }
    applySettings(state.settings);
    syncAaControls();
    send('saveSettings', { patch });
    return patch;
  }

  /** TOC 点击：阻止默认跳转，按「标题 top − 工具条占位」平滑滚动到目标。 */
  function onTocClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const link = target.closest('a[href^="#"]');
    if (!link || !toc.contains(link)) {
      return;
    }
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    const id = href.slice(1);
    const heading = state.headings.find((item) => item.id === id);
    if (!heading) {
      return;
    }
    const top = heading.top - TOC_TOOLBAR_OFFSET;
    if (typeof content.scrollTo === 'function') {
      content.scrollTo({ top, behavior: 'smooth' });
    } else {
      content.scrollTop = top;
    }
  }

  function openAaPanel() {
    aaPanel.hidden = false;
    aaToggle.setAttribute('aria-expanded', 'true');
  }

  function closeAaPanel() {
    aaPanel.hidden = true;
    aaToggle.setAttribute('aria-expanded', 'false');
  }

  function toggleAaPanel() {
    if (aaPanel.hidden) {
      openAaPanel();
    } else {
      closeAaPanel();
    }
  }

  /** 点击面板外部关闭；面板/触发按钮内部的点击不关闭（触发按钮那一下会在打开后冒泡到这里）。 */
  function onDocumentClick(event) {
    if (aaPanel.hidden) {
      return;
    }
    const target = event.target;
    if (!target) {
      return;
    }
    if (aaPanel.contains(target) || aaToggle.contains(target)) {
      return;
    }
    closeAaPanel();
  }

  /** Aa 面板控件变更（input 覆盖滑杆拖动，change 覆盖下拉选择）→ 即时应用并持久化。 */
  function onAaControlChange(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const control = target.closest('[data-setting]');
    if (!control || !aaPanel.contains(control)) {
      return;
    }
    const key = control.dataset.setting;
    const value = coerceSettingValue(key, control.value);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return;
    }
    updateSettings({ [key]: value });
  }

  /**
   * 全局快捷键（输入框内不触发）：
   * Ctrl+B 侧栏显隐、Ctrl+= / Ctrl+- 字号 ±1、Ctrl+0 重置 16、Ctrl+, 排版面板、Esc 关闭浮层。
   * 工具条显隐（Alt）归 Task 12，本任务不抢该键。
   */
  function onKeyDown(event) {
    if (!event || event.defaultPrevented) {
      return;
    }
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Escape') {
      if (!aaPanel.hidden) {
        closeAaPanel();
      }
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }
    const ctrl = Boolean(event.ctrlKey || event.metaKey);
    if (!ctrl || event.altKey) {
      return;
    }

    if (key === 'b' || key === 'B') {
      event.preventDefault();
      updateSettings({ tocVisible: !state.settings.tocVisible });
      return;
    }
    if (key === '=' || key === '+') {
      event.preventDefault();
      updateSettings({ fontSize: state.settings.fontSize + 1 });
      return;
    }
    if (key === '-' || key === '_') {
      event.preventDefault();
      updateSettings({ fontSize: state.settings.fontSize - 1 });
      return;
    }
    if (key === '0') {
      event.preventDefault();
      updateSettings({ fontSize: 16 });
      return;
    }
    if (key === ',' || key === '<') {
      event.preventDefault();
      toggleAaPanel();
    }
  }

  /**
   * 正文渲染：优先走 JJ.renderMarkdown（与宿主共用同一 markdown-it 实现，baseUrl 用于解析相对图片）。
   * 每次渲染都传新的 env 字面量（T8 carry-forward：env 会被写入 frontmatter，复用会串文档）。
   * 顺序：innerHTML → front matter 属性块 → 标题 id 兜底 + 建 TOC → JJ.enhance（T10 决策 3：兜底在 enhance 之前）。
   * 引擎缺失（打包缺失/加载失败）时降级为 escapeHtml + <pre>，保证正文区永远不白屏。
   * @returns {{id: string, text: string, level: number, top: number}[]} 渲染后 DOM 的标题列表
   */
  function render(markdown) {
    const engine = globalThis.JJ;
    if (engine && typeof engine.renderMarkdown === 'function') {
      content.innerHTML = engine.renderMarkdown(markdown, { baseUrl: state.baseUrl });
      mountFrontmatter(markdown);
      const headings = assignHeadingIds(markdown);
      renderToc(headings);
      if (typeof engine.enhance === 'function') {
        try {
          engine.enhance(content, { baseUrl: state.baseUrl });
        } catch {
          // 增强失败（复制按钮/图片占位）不能影响已经渲染好的正文
        }
      }
      return headings;
    }
    content.innerHTML = `<pre class="jj-fallback">${escapeHtml(markdown)}</pre>`;
    state.extractedCount = 0;
    renderToc([]);
    return [];
  }

  function renderLoad(payload) {
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
    state.path = typeof payload.path === 'string' ? payload.path : '';
    state.key = typeof payload.key === 'string' ? payload.key : '';
    state.baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl : '';
    state.position = typeof payload.position === 'number' ? payload.position : null;

    // 设置先落地（主题先写 data-theme 再重绘正文，避免切换白闪）：默认值 + 宿主下发值，全部夹紧。
    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    state.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    applySettings(state.settings);
    applyThemeState();
    applyTocVisibility();
    syncAaControls();

    const started = now();
    render(markdown);
    // 契约（spec §4.4）：renderDone{path, elapsedMs, tocCount, bytes}；tocCount 复用渲染期 extractHeadings 的结果
    const tocCount = state.extractedCount;
    const elapsedMs = Math.max(0, now() - started);

    send('renderDone', {
      path: state.path,
      elapsedMs,
      tocCount,
      bytes: utf8Length(markdown),
    });
  }

  function showToast(text, level = 'info') {
    const item = document.createElement('div');
    item.className = 'toast';
    item.dataset.level = level;
    item.setAttribute('role', 'status');
    item.textContent = String(text ?? '');
    toast.hidden = false;
    toast.append(item);
  }

  /** 消息分发：load/toast/assocState/dirListing；未知 type 静默忽略（坏消息不能中断 shell）。 */
  function onMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    switch (type) {
      case 'load':
        renderLoad(payload);
        break;
      case 'toast':
        showToast(payload.text, payload.level);
        break;
      case 'assocState':
        state.assoc = { registered: Boolean(payload.registered), isDefault: Boolean(payload.isDefault) };
        break;
      case 'dirListing':
        state.dirListing = payload;
        break;
      default:
        break;
    }
  }

  // 首屏（load 之前）就用默认偏好：主题/排版/侧栏状态先落地，宿主推 load 时只做增量。
  applySettings(state.settings);
  applyThemeState();
  applyTocVisibility();
  syncAaControls();
  toc.replaceChildren(buildToc([]));

  themeToggle.addEventListener('click', () => {
    updateSettings({ theme: nextTheme(state.settings.theme) });
  });
  tocToggle.addEventListener('click', () => {
    updateSettings({ tocVisible: !state.settings.tocVisible });
  });
  aaToggle.addEventListener('click', toggleAaPanel);
  aaPanel.addEventListener('input', onAaControlChange);
  aaPanel.addEventListener('change', onAaControlChange);
  toc.addEventListener('click', onTocClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocumentClick);

  /** 卸下全局监听与滚动联动（测试/多实例装配用；WebView2 页面生命周期内不需要调用）。 */
  function destroy() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('click', onDocumentClick);
    toc.removeEventListener('click', onTocClick);
    aaPanel.removeEventListener('input', onAaControlChange);
    aaPanel.removeEventListener('change', onAaControlChange);
    if (state.spy) {
      state.spy.destroy();
      state.spy = null;
    }
  }

  // 握手：shell 装配完成（监听器已就绪）→ 通知宿主可以推 load 了（只发一次）。
  send('shellReady', {});

  return { root, onMessage, destroy };
}
