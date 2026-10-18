// 最近文件面板（Task 12）：空白启动页展示 + 键盘导航，供 main.js 的空白页与（后续）工具条菜单共用。
// 安全约束：路径/文件名/目录都是不可信文本——只用 textContent / dataset 写入，绝不拼 HTML 字符串。
// 界面美化波：空状态插入自绘的鲸鱼女仆娘插画（常量 SVG，装饰性 aria-hidden；非用户内容）。

import { MASCOT_PHOTO } from '../mascot-photo.js';

/** 最近文件条数上限（Global Constraints：20 条）。 */
export const MAX_RECENT = 20;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 从路径取显示名（宿主一般已下发 name，缺失时兜底）。 */
function baseName(path) {
  const text = String(path ?? '');
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return index >= 0 ? text.slice(index + 1) : text;
}

/** 从路径取目录（宿主一般已下发 dir，缺失时兜底）。 */
function dirName(path) {
  const text = String(path ?? '');
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return index > 0 ? text.slice(0, index) : '';
}

/**
 * 归一化最近文件条目：过滤无效项（无 path）、去重（Windows 路径大小写不敏感）、最多 20 条。
 * @param {Array<{path?: string, name?: string, dir?: string, openedAt?: string}>} items
 * @returns {{path: string, name: string, dir: string, openedAt: string}[]}
 */
export function normalizeRecentItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const list = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const path = typeof item.path === 'string' ? item.path : '';
    if (path === '') {
      continue;
    }
    const key = path.toLowerCase().replace(/\//g, '\\');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push({
      path,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : baseName(path),
      dir: typeof item.dir === 'string' ? item.dir : dirName(path),
      openedAt: typeof item.openedAt === 'string' ? item.openedAt : '',
    });
    if (list.length >= MAX_RECENT) {
      break;
    }
  }
  return list;
}

/**
 * 相对时间文案（最近文件列表用）：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / YYYY-MM-DD。
 * 解析失败或空值返回空串（不显示时间标签）。
 * @param {string} value 宿主 openedAt（UTC ISO 8601）
 * @param {number} [now] 当前时间（测试注入；默认 Date.now()）
 */
export function formatRelativeTime(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return '';
  }
  const diff = Math.max(0, now - time);
  if (diff < MINUTE_MS) {
    return '刚刚';
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)} 小时前`;
  }
  if (diff < 2 * DAY_MS) {
    return '昨天';
  }
  if (diff < 30 * DAY_MS) {
    return `${Math.floor(diff / DAY_MS)} 天前`;
  }
  const date = new Date(time);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 路径比较键（Windows 大小写不敏感、分隔符统一）。 */
function pathKey(path) {
  return typeof path === 'string' ? path.trim().toLowerCase().replace(/\//g, '\\') : '';
}

/**
 * 最近文件顺序切换（Alt+←/→）：older = 打开时间更早（列表更靠后），newer = 更新（列表更靠前）。
 * 当前文档不在列表里时两边都落到最新一项（列表第 0 项）；到达两端返回 null（不循环）。
 * @param {object[]} items 最近文件列表（最新在前）
 * @param {string} currentPath 当前文档绝对路径
 * @param {'older'|'newer'} direction
 * @returns {string | null}
 */
export function nextRecentPath(items, currentPath, direction) {
  const list = normalizeRecentItems(items);
  if (list.length === 0) {
    return null;
  }
  const current = pathKey(currentPath);
  const index = current === '' ? -1 : list.findIndex((item) => pathKey(item.path) === current);
  if (index < 0) {
    return list[0].path;
  }
  const target = direction === 'older' ? index + 1 : index - 1;
  return target >= 0 && target < list.length ? list[target].path : null;
}

/**
 * 渲染最近文件面板（标题 + 「打开文件」按钮 + 列表 + 打开提示）。
 * 列表项是 button[data-path]（显示名 + 目录 + 相对时间）；↑↓ 移动焦点、Enter 打开、Esc 关闭、点击打开。
 * 修复波 B-§5.11：空白启动页必须有可见的「打开文件」按钮（不依赖用户记住 Ctrl+O）。
 * @param {object[]} items {path, name, dir, openedAt}[]
 * @param {{onOpen?: (path: string) => void, onClose?: () => void, onPickFile?: () => void}} [options]
 * @returns {HTMLElement} section.recent-panel
 */
export function renderRecent(items, { onOpen, onClose, onPickFile } = {}) {
  const list = normalizeRecentItems(items);
  const panel = document.createElement('section');
  panel.className = 'recent-panel';
  panel.setAttribute('aria-label', '最近文件');

  const title = document.createElement('p');
  title.className = 'recent-title';
  title.textContent = '最近文件';
  panel.append(title);

  // 空白启动页的「打开文件」入口：与工具条/Ctrl+O 走同一条 pickFile 消息（宿主弹系统对话框）。
  const pickFileButton = document.createElement('button');
  pickFileButton.type = 'button';
  pickFileButton.className = 'recent-open';
  pickFileButton.textContent = '打开文件…';
  pickFileButton.title = '打开 Markdown 文件（Ctrl+O）';
  pickFileButton.addEventListener('click', () => {
    if (typeof onPickFile !== 'function') {
      return;
    }
    try {
      onPickFile();
    } catch {
      // 打开对话框失败不能打断面板
    }
  });
  panel.append(pickFileButton);

  const listRoot = document.createElement('nav');
  listRoot.className = 'recent-list';
  let activeIndex = -1;

  const open = (path) => {
    if (typeof path !== 'string' || path === '') {
      return;
    }
    if (typeof onOpen === 'function') {
      try {
        onOpen(path);
      } catch {
        // 打开动作（宿主消息）失败不能打断键盘导航
      }
    }
  };

  const close = () => {
    panel.hidden = true;
    if (typeof onClose === 'function') {
      try {
        onClose();
      } catch {
        // 关闭回调失败不影响面板隐藏
      }
    }
  };

  const buttons = [];
  for (const item of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.dataset.path = item.path;
    button.title = item.path;

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = item.name;

    const dir = document.createElement('span');
    dir.className = 'recent-dir';
    dir.textContent = item.dir;

    const timeText = formatRelativeTime(item.openedAt);
    button.append(name, dir);
    if (timeText !== '') {
      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = timeText;
      button.append(time);
    }
    button.addEventListener('click', () => open(item.path));
    buttons.push(button);
    listRoot.append(button);
  }

  if (buttons.length === 0) {
    // 空状态：鲸鱼女仆娘看书插画（reader 风小尺寸、whale 风主角，尺寸由 CSS 决定）。
    const mascot = document.createElement('img');
    mascot.className = 'recent-mascot';
    mascot.alt = '';
    mascot.setAttribute('aria-hidden', 'true');
    mascot.decoding = 'async';
    mascot.src = MASCOT_PHOTO;
    panel.prepend(mascot);
    const empty = document.createElement('p');
    empty.className = 'recent-empty';
    empty.textContent = '还没有打开过文档';
    panel.append(empty);
  } else {
    panel.append(listRoot);
  }

  const hint = document.createElement('p');
  hint.className = 'recent-hint';
  hint.textContent = '拖入 .md 或 Ctrl+O 打开';
  panel.append(hint);

  /** 焦点移动：从 -1 开始向下到第 0 项；越界夹紧（不循环）。 */
  function focusItem(index) {
    if (buttons.length === 0) {
      return;
    }
    activeIndex = Math.min(buttons.length - 1, Math.max(0, index));
    buttons[activeIndex].focus();
  }

  /** 实际焦点项下标（焦点不在本面板的列表项内时返回 -1）。 */
  function focusedIndex() {
    const focused = document.activeElement;
    if (focused && typeof focused.dataset === 'object' && typeof focused.dataset.path === 'string') {
      const index = buttons.indexOf(focused);
      if (index >= 0) {
        return index;
      }
    }
    return -1;
  }

  panel.addEventListener('keydown', (event) => {
    if (!event) {
      return;
    }
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'ArrowDown') {
      event.preventDefault();
      // 焦点可能由外部（工具条菜单打开时）直接设在第一项：从实际焦点继续移动，不能停在原地
      const focused = focusedIndex();
      focusItem(focused >= 0 ? focused + 1 : activeIndex + 1);
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      const focused = focusedIndex();
      focusItem(focused >= 0 ? focused - 1 : activeIndex - 1);
      return;
    }
    if (key === 'Enter') {
      // 只拦截「最近项」上的 Enter（复评 Important：「打开文件…」按钮也是面板子节点）：
      // 焦点在按钮时放行默认行为（浏览器把 Enter 转成 click → pickFile），
      // 否则键盘用户按 Enter 会误开最近第一条而不是文件对话框。
      const target = event.target;
      const item = target && typeof target.closest === 'function' ? target.closest('[data-path]') : null;
      if (!item) {
        return;
      }
      event.preventDefault();
      open(item.dataset.path);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  return panel;
}
