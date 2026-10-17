// 文件树侧栏（Task 14）：把宿主 dirListing 的条目渲染成 ul > li[data-rel][data-dir]。
// 设计约束：
//   - 名字只写 textContent、路径只进 data-rel，不拼 HTML（宿主返回的文件名不可信）；
//   - 目录惰性加载：首次展开调用注入的 post('listDir', {path})（或 onExpand），收到 dirListing 后
//     由 applyDirListing 按 relPath 找到节点填子级，并用 data-loaded 防止重复请求；
//   - 根列表（path === ""）替换整棵树；侧栏用 data-sidebar='toc'|'tree' 切换大纲/文件树；
//   - 点击文件交给 onOpen(relPath)，绝对路径拼接与宿主校验由 shell 负责。

const TREE_ID = 'file-tree';
const SIDEBAR_ID = 'toc';

/** 统一路径分隔符并去掉首尾 /（relPath 相对 root，空串表示 root）。 */
function normalizeRelPath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * 过滤宿主条目：只保留 name/relPath 非空的字符串项，isDir 归一为布尔。
 * 非法项静默丢弃：一条坏数据不能阻止整棵树渲染。
 */
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name === '') {
      continue;
    }
    const relPath = normalizeRelPath(entry.relPath);
    if (relPath === '') {
      continue;
    }
    normalized.push({ name, isDir: Boolean(entry.isDir), relPath });
  }
  return normalized;
}

/** 直接子元素里的内容列表（li > ul.tree-children）。 */
function childList(li) {
  for (const child of li.children) {
    if (child.tagName === 'UL') {
      return child;
    }
  }
  return null;
}

/** 直接子元素里的展开三角按钮。 */
function toggleButton(li) {
  for (const child of li.children) {
    if (child.classList && child.classList.contains('tree-toggle')) {
      return child;
    }
  }
  return null;
}

/** 展开/折叠目录节点的视觉状态（不负责列表请求）。 */
function setExpanded(li, expanded) {
  li.dataset.expanded = expanded ? 'true' : 'false';
  const children = childList(li);
  if (children) {
    children.hidden = !expanded;
  }
  const toggle = toggleButton(li);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '▾' : '▸';
  }
}

/** 创建一个条目节点：目录带三角按钮与空的子列表，文件是可点击按钮。 */
function createEntry(entry) {
  const li = document.createElement('li');
  li.dataset.rel = entry.relPath;
  li.dataset.dir = entry.isDir ? 'true' : 'false';

  if (entry.isDir) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `展开 ${entry.name}`);
    toggle.textContent = '▸';

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tree-name';
    label.textContent = entry.name;

    const children = document.createElement('ul');
    children.className = 'tree-children';
    children.hidden = true;

    li.append(toggle, label, children);
    return li;
  }

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle-spacer';
  spacer.setAttribute('aria-hidden', 'true');

  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'tree-name';
  label.textContent = entry.name;

  li.append(spacer, label);
  return li;
}

/** 把条目追加到指定列表（根 ul 或某目录的子 ul 都适用）。 */
function appendEntries(list, entries) {
  for (const entry of normalizeEntries(entries)) {
    list.append(createEntry(entry));
  }
}

/**
 * 请求目录子项：优先 onExpand(relPath)，否则 post('listDir', {path: relPath})。
 * 请求过的节点记 data-requested，避免连点/双触发重复发消息；收到列表后由 applyDirListing 清掉。
 */
function requestChildren(li, options) {
  if (li.dataset.loaded === 'true' || li.dataset.requested === 'true') {
    return;
  }
  const hasOnExpand = typeof options.onExpand === 'function';
  const hasPost = typeof options.post === 'function';
  if (!hasOnExpand && !hasPost) {
    return;
  }
  li.dataset.requested = 'true';
  delete li.dataset.failed;
  if (hasOnExpand) {
    options.onExpand(li.dataset.rel);
    return;
  }
  options.post('listDir', { path: li.dataset.rel });
}

/** 目录点击：已展开则折叠；折叠态展开并在首次展开时请求子项。 */
function toggleDirectory(li, options) {
  const expanded = li.dataset.expanded === 'true';
  setExpanded(li, !expanded);
  if (expanded) {
    // 折叠时解除「请求中」标记：宿主读目录失败（toast）后，用户可以再次展开重试
    if (li.dataset.loaded !== 'true') {
      delete li.dataset.requested;
    }
    return;
  }
  requestChildren(li, options);
}

/**
 * 渲染一棵文件树，返回 ul.file-tree。
 * @param {{name: string, isDir: boolean, relPath: string}[]} entries 宿主 dirListing 的条目（相对 root）
 * @param {{rootName?: string, onOpen?: (relPath: string) => void, post?: Function, onExpand?: Function}} [options]
 * @returns {HTMLUListElement}
 */
export function renderTree(entries, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const list = document.createElement('ul');
  list.className = 'file-tree';
  list.setAttribute('aria-label', typeof opts.rootName === 'string' && opts.rootName ? `文件树：${opts.rootName}` : '文件树');

  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const li = target.closest('li[data-rel]');
    if (!li || !list.contains(li)) {
      return;
    }
    event.preventDefault();
    if (li.dataset.dir === 'true') {
      toggleDirectory(li, opts);
    } else if (typeof opts.onOpen === 'function') {
      opts.onOpen(li.dataset.rel);
    }
  });

  appendEntries(list, entries);
  return list;
}

/** 在树里按相对路径找节点（遍历比较 dataset，避免把路径拼进 CSS 选择器）。 */
function findByRel(tree, relPath) {
  for (const li of tree.querySelectorAll('li[data-rel]')) {
    if (li.dataset.rel === relPath) {
      return li;
    }
  }
  return null;
}

/**
 * 应用一条 dirListing：
 * - root 列表（path 为空）替换整棵树；
 * - 子目录列表按 relPath 找到目录节点填子级、展开、标记 data-loaded。
 * @param {{root?: string, path?: string, entries?: object[]}} payload
 * @param {{rootName?: string, onOpen?: Function, post?: Function, onExpand?: Function}} [options]
 * @returns {boolean} 是否已应用到 DOM（找不到树/父节点或缺少 root 时 false）
 */
export function applyDirListing(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const root = typeof payload.root === 'string' ? payload.root : '';
  if (root === '') {
    return false;
  }
  const container = document.getElementById(TREE_ID);
  if (!container) {
    return false;
  }

  const path = normalizeRelPath(payload.path);
  const opts = options && typeof options === 'object' ? options : {};
  const rootName = typeof opts.rootName === 'string' && opts.rootName ? opts.rootName : root;

  if (path === '') {
    const list = renderTree(payload.entries, { ...opts, rootName });
    if (list.querySelectorAll('li[data-rel]').length === 0) {
      const empty = document.createElement('p');
      empty.className = 'tree-empty';
      empty.textContent = '此文件夹没有可显示的文档';
      container.replaceChildren(empty);
    } else {
      container.replaceChildren(list);
    }
    return true;
  }

  const tree = container.querySelector('ul.file-tree');
  if (!tree) {
    return false;
  }
  const parent = findByRel(tree, path);
  if (!parent || parent.dataset.dir !== 'true') {
    return false;
  }
  const children = childList(parent);
  if (!children) {
    return false;
  }

  children.replaceChildren();
  const entries = normalizeEntries(payload.entries);
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'tree-empty';
    empty.textContent = '（空文件夹）';
    children.append(empty);
  } else {
    appendEntries(children, entries);
  }

  parent.dataset.loaded = 'true';
  delete parent.dataset.requested;
  delete parent.dataset.failed;
  // 保留当前展开/折叠状态：请求在途时用户可能已经折叠该目录，晚到的列表不能强行展开（评审 Minor 4）。
  return true;
}

/**
 * 目录请求失败（宿主读取失败只发 toast，不回 dirListing）：清除在途标记、标记 data-failed 并折叠节点；
 * 下一次单击 = 展开 → 重新请求，不需要先折叠再展开（评审 Minor 3）。
 */
export function failPendingTreeRequests() {
  const container = document.getElementById(TREE_ID);
  if (!container) {
    return;
  }
  for (const li of container.querySelectorAll('li[data-requested="true"]')) {
    delete li.dataset.requested;
    li.dataset.failed = 'true';
    setExpanded(li, false);
  }
}

/**
 * 当前打开文件的高亮：清掉旧 .active/aria-current，按相对 root 的路径标记对应文件节点；
 * 已加载的祖先目录会顺带展开，保证高亮项可见（不会额外发 listDir）。
 * @param {string} relPath 相对浏览根的路径；空串只清除高亮
 */
export function setTreeActive(relPath) {
  const container = document.getElementById(TREE_ID);
  if (!container) {
    return;
  }
  const normalized = normalizeRelPath(relPath);
  for (const li of container.querySelectorAll('li[data-rel].active')) {
    li.classList.remove('active');
    li.removeAttribute('aria-current');
  }
  if (normalized === '') {
    return;
  }

  const tree = container.querySelector('ul.file-tree');
  if (!tree) {
    return;
  }
  let active = findByRel(tree, normalized);
  if (!active) {
    // Windows 路径大小写不敏感：宿主 load 的 path 与树里 relPath 的大小写可能不同
    const lower = normalized.toLowerCase();
    for (const li of tree.querySelectorAll('li[data-rel]')) {
      if (li.dataset.rel.toLowerCase() === lower) {
        active = li;
        break;
      }
    }
  }
  if (!active) {
    return;
  }

  // 展开祖先目录（只切显示状态；未加载的目录保持折叠，避免为了高亮触发全树请求）。
  const targetRel = active.dataset.rel;
  const segments = targetRel.split('/');
  let prefix = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = prefix === '' ? segments[index] : `${prefix}/${segments[index]}`;
    const ancestor = findByRel(tree, prefix);
    if (ancestor && ancestor.dataset.loaded === 'true') {
      setExpanded(ancestor, true);
    }
  }

  active.classList.add('active');
  active.setAttribute('aria-current', 'true');
}

/**
 * 切换侧栏内容：'tree' 显示文件树、'toc' 显示大纲（未知值按大纲处理）。
 * 侧栏写 data-sidebar 供 CSS 折叠对应的子容器；树容器 hidden 同步兜底。
 * @param {'toc'|'tree'} mode
 */
export function setSidebarMode(mode) {
  const sidebar = document.getElementById(SIDEBAR_ID);
  if (!sidebar) {
    return;
  }
  const next = mode === 'tree' ? 'tree' : 'toc';
  sidebar.dataset.sidebar = next;
  const nav = document.getElementById('toc-nav');
  if (nav) {
    nav.hidden = next !== 'toc';
  }
  const tree = document.getElementById(TREE_ID);
  if (tree) {
    tree.hidden = next !== 'tree';
  }
}
