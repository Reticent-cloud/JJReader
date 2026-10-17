// 文件夹浏览控制器（Task 14 评审拆分）：浏览根状态、dirListing 应用与校验、树/大纲模式切换、
// 树内打开与当前文件高亮；main.js 只负责装配（注入工具条按钮、post 与当前文档路径）。
// 路径口径（评审 Important）：宿主 FileHost.NormalizePath 对 >255 的路径加 \\?\（UNC 为 \\?\UNC\），
// 而浏览根可能是短路径——所有「是否在根内 / 是否同一个根」比较都必须先经 normalizeForCompare 归一，
// 但绝对路径本身（打开文件、显示根名）保持宿主下发的原样。

import { applyDirListing, failPendingTreeRequests, setSidebarMode, setTreeActive } from './tree.js';

/** Windows 扩展长度路径前缀：\\?\（本地盘）与 \\?\UNC\（网络共享）。 */
const EXTENDED_UNC_PREFIX = '\\\\?\\UNC\\';
const EXTENDED_PREFIX = '\\\\?\\';
/** 设备路径前缀 \\.\（与 FileHost 口径一致）。 */
const DEVICE_PREFIX = '\\\\.\\';

/** 相对路径归一：去首尾空白、反斜杠转 /、去掉首尾分隔符（空串表示浏览根）。 */
function normalizeRelPath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * 路径比较用的规范形式：去首尾空白、统一 \ 分隔符、去掉 \\?\ / \\?\UNC\ / \\.\ 前缀
 * （\\?\UNC\server\share 还原成 \\server\share）、去尾随分隔符、统一小写。
 * 仅用于「包含性 / 同一性」比较，不能用于文件系统访问（>255 的路径需要保留前缀才稳）。
 * @param {string} path
 * @returns {string} 规范化后的比较键；非字符串/空串返回 ''
 */
export function normalizeForCompare(path) {
  if (typeof path !== 'string') {
    return '';
  }
  let value = path.trim().replace(/\//g, '\\');
  if (value === '') {
    return '';
  }
  if (value.startsWith(EXTENDED_UNC_PREFIX)) {
    value = '\\\\' + value.slice(EXTENDED_UNC_PREFIX.length);
  } else if (value.startsWith(EXTENDED_PREFIX)) {
    value = value.slice(EXTENDED_PREFIX.length);
  } else if (value.startsWith(DEVICE_PREFIX)) {
    value = value.slice(DEVICE_PREFIX.length);
  }
  return value.replace(/\\+$/, '').toLowerCase();
}

/**
 * 文件绝对路径相对浏览根的路径（'/' 分隔）；不在根内 / 根或路径为空时返回 null。
 * 两侧都归一后按分隔符边界比较（避免 C:\notes 误配 C:\notes2），Windows 大小写不敏感。
 * @param {string} filePath 宿主加载的文档绝对路径（可能是带 \\?\ 的长路径）
 * @param {string} root 浏览根绝对路径（宿主 dirListing.root）
 * @returns {string|null}
 */
export function relPathInsideRoot(filePath, root) {
  const file = normalizeForCompare(filePath);
  const base = normalizeForCompare(root);
  if (file === '' || base === '' || file === base) {
    return null;
  }
  const prefix = base.endsWith('\\') ? base : `${base}\\`;
  if (!file.startsWith(prefix)) {
    return null;
  }
  return file.slice(prefix.length).replace(/\\/g, '/');
}

/** 绝对路径 = root + '/' + relPath（用 / 拼接，宿主 NormalizePath 统一成 \）；根尾随分隔符不产生双斜杠。 */
export function joinRootPath(root, relPath) {
  const base = String(root).replace(/[\\/]+$/, '');
  const relative = String(relPath).replace(/^[\\/]+/, '');
  if (base === '') {
    return relative;
  }
  return `${base}/${relative}`;
}

/** 浏览根显示名：取最后一段路径（盘符根等取不到名称时回退完整路径）。 */
export function rootDisplayName(root) {
  const trimmed = String(root).replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  const name = parts[parts.length - 1];
  return name ? name : String(root);
}

/**
 * 创建文件夹浏览控制器（浏览根 + 侧栏模式）。
 * @param {{browseRootButton?: HTMLElement, treeBackButton?: HTMLElement, post?: Function, getDocumentPath?: () => string}} [options]
 *   browseRootButton：工具条根目录名（点击回树）；treeBackButton：「大纲」返回按钮；
 *   post：发消息（openFile）；getDocumentPath：当前打开的文档绝对路径（dirListing 到达后同步高亮）。
 * @returns {{applyListing: Function, syncForDocument: Function, onToast: Function, showTocMode: Function, destroy: Function}}
 */
export function createBrowser({ browseRootButton, treeBackButton, post, getDocumentPath } = {}) {
  const send = typeof post === 'function' ? post : () => {};
  const readDocumentPath = typeof getDocumentPath === 'function' ? getDocumentPath : () => '';
  const rootButton = browseRootButton || null;
  const backButton = treeBackButton || null;

  const state = {
    root: '',
    rootName: '',
    mode: 'toc',
  };

  /** 工具条浏览根提示：有根时显示目录名（点击回树），树模式下同时显示「大纲」返回按钮。 */
  function applyChrome() {
    const hasRoot = state.root !== '';
    const treeVisible = hasRoot && state.mode === 'tree';
    if (rootButton) {
      rootButton.hidden = !hasRoot;
      rootButton.textContent = hasRoot ? state.rootName : '';
      rootButton.title = hasRoot ? `显示文件树：${state.rootName}` : '显示文件树';
      rootButton.setAttribute('aria-label', hasRoot ? `显示文件树：${state.rootName}` : '显示文件树');
      rootButton.classList.toggle('active', treeVisible);
    }
    if (backButton) {
      backButton.hidden = !treeVisible;
    }
  }

  /** 进入文件树模式（侧栏隐藏大纲、显示树；不改变浏览根）。 */
  function enterTreeMode() {
    state.mode = 'tree';
    setSidebarMode('tree');
    applyChrome();
  }

  /** 回到大纲模式（保留浏览根与已加载的树，工具条根名可再切回）。 */
  function showTocMode() {
    state.mode = 'toc';
    setSidebarMode('toc');
    applyChrome();
  }

  /** 工具条根目录名点击：有浏览根时切回文件树。 */
  function onBrowseRootClick() {
    if (state.root !== '') {
      enterTreeMode();
    }
  }

  /** 树中点击文件：把绝对路径交给宿主（宿主再做 NormalizePath/存在性校验）。 */
  function openTreeFile(relPath) {
    if (typeof relPath !== 'string' || relPath === '' || state.root === '') {
      return;
    }
    send('openFile', { relPath: joinRootPath(state.root, relPath) });
  }

  /** 当前文档按浏览根定位并高亮（根外/无根时只清除高亮）。 */
  function syncActive(filePath) {
    if (state.root === '') {
      setTreeActive('');
      return;
    }
    const relative = relPathInsideRoot(filePath, state.root);
    setTreeActive(relative !== null ? relative : '');
  }

  /**
   * 应用一条 dirListing：
   * - 根列表（path 为空）：替换整棵树、记住浏览根并进入树模式；
   * - 子列表：迟到消息（root 与当前浏览根不一致）直接丢弃，避免切根竞态把旧根内容填进新树。
   * @param {{root?: string, path?: string, entries?: object[]}} payload
   * @returns {boolean} 是否已应用到 DOM
   */
  function applyListing(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const root = typeof payload.root === 'string' ? payload.root : '';
    if (root === '') {
      return false;
    }
    const isRootListing = normalizeRelPath(payload.path) === '';
    if (!isRootListing) {
      if (state.root === '' || normalizeForCompare(root) !== normalizeForCompare(state.root)) {
        // 旧根的子列表晚到（切根竞态）或尚未建立浏览根：丢弃，不污染当前树
        return false;
      }
    }

    const rootName = isRootListing ? rootDisplayName(root) : state.rootName;
    const applied = applyDirListing(payload, { rootName, onOpen: openTreeFile, post: send });
    if (!applied) {
      return false;
    }

    if (isRootListing) {
      // 根列表：记住浏览根并进入树模式（宿主 pickFolder 后先推根列表再 toast）
      state.root = root;
      state.rootName = rootName;
      enterTreeMode();
    }
    // 目录列表到达后若已有打开文档：同步高亮（先打开文档、后打开文件夹的场景）
    syncActive(readDocumentPath());
    applyChrome();
    return true;
  }

  /**
   * load 之后同步树状态：
   * - 新文档在浏览根内 → 高亮对应节点（树模式保持不变，点击树中文件不会跳回大纲）；
   * - 在根外 → 当前是树模式则恢复大纲（Global Constraints：打开新的单文件时侧栏恢复大纲模式），
   *   浏览根保留，工具条根名仍可一键切回树。
   */
  function syncForDocument() {
    if (state.root === '') {
      setTreeActive('');
      applyChrome();
      return;
    }
    const relative = relPathInsideRoot(readDocumentPath(), state.root);
    if (relative !== null) {
      setTreeActive(relative);
      applyChrome();
      return;
    }
    setTreeActive('');
    if (state.mode === 'tree') {
      showTocMode();
      return;
    }
    applyChrome();
  }

  /**
   * 宿主 toast 到达：warn/error 且树里有在途目录请求 → 请求必然失败（宿主失败只发 toast，不回 dirListing），
   * 清除在途标记并折叠该节点，下一次单击即可重试（评审 Minor 3）。
   * info 级别（成功提示等）不触发，避免误伤在途请求。
   */
  function onToast(payload) {
    if (!payload || (payload.level !== 'warn' && payload.level !== 'error')) {
      return;
    }
    failPendingTreeRequests();
  }

  function destroy() {
    if (rootButton) {
      rootButton.removeEventListener('click', onBrowseRootClick);
    }
    if (backButton) {
      backButton.removeEventListener('click', showTocMode);
    }
  }

  if (rootButton && typeof rootButton.addEventListener === 'function') {
    rootButton.addEventListener('click', onBrowseRootClick);
  }
  if (backButton && typeof backButton.addEventListener === 'function') {
    backButton.addEventListener('click', showTocMode);
  }
  applyChrome();

  return { applyListing, syncForDocument, onToast, showTocMode, destroy };
}
