// Task 14：文件树侧栏（renderTree / setSidebarMode / dirListing 填充 / 当前文件高亮 / 打开文件）。
// jsdom 没有真实文件系统：条目数组与宿主消息全部由用例构造；宿主侧目录枚举由 DirectoryListerTests 覆盖。
// 断言口径：树节点 li[data-rel][data-dir]、目录惰性展开只发一次 listDir、根列表替换整棵树、
// 点击文件把 root + '/' + relPath 作为绝对路径发给宿主（中文/空格路径不做任何转义，交给宿主 NormalizePath）。

const mounted = [];

/** 每个用例独立的 #app 容器（mountShell 的 root 就是 #app 本身）。 */
function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

/** 装配 shell，返回 { root, shell, posted }；destroy 在 afterEach 统一调用。 */
function mount() {
  const root = createRoot();
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
  mounted.push(shell);
  return { root, shell, posted };
}

/** 推一条 load 消息（字段与宿主契约一致）。 */
function load(shell, overrides = {}) {
  shell.onMessage({
    type: 'load',
    payload: {
      path: 'C:\\notes\\a.md',
      key: 'key-a',
      baseUrl: 'https://md.local/',
      markdown: '# 甲',
      settings: {},
      position: null,
      ...overrides,
    },
  });
}

/** 推一条 dirListing（path 省略 = 根列表）。 */
function sendListing(shell, root, entries, path = '') {
  shell.onMessage({ type: 'dirListing', payload: { root, path, entries } });
}

/** 取某类消息的最后一条 payload；没有则 undefined。 */
function lastPayload(posted, type) {
  const messages = posted.filter((message) => message.type === type);
  return messages.length > 0 ? messages.at(-1).payload : undefined;
}

/** 树中指定 relPath 的节点。 */
function findNode(root, relPath) {
  return root.querySelector(`#file-tree li[data-rel="${relPath}"]`);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.innerHTML = '';
});

// ── brief 的两个基础用例 ──

it('文件树渲染目录与文件节点，点击文件触发打开', () => {
  const opened = [];
  const el = JJ.renderTree([
    { name: '子目录', isDir: true, relPath: '子目录' },
    { name: 'a.md', isDir: false, relPath: 'a.md' },
  ], { rootName: 'notes', onOpen: (path) => opened.push(path) });

  expect(el.querySelectorAll('[data-rel]')).toHaveLength(2);
  expect(el.querySelector('[data-rel="子目录"]').getAttribute('data-dir')).toBe('true');
  expect(el.querySelector('[data-rel="a.md"]').getAttribute('data-dir')).toBe('false');
  el.querySelector('[data-rel="a.md"]').click();
  expect(opened).toEqual(['a.md']);
});

it('目录节点展开时请求 listDir', () => {
  const posted = [];
  const el = JJ.renderTree([{ name: 'sub', isDir: true, relPath: 'sub' }], {
    rootName: 'notes',
    onOpen() {},
    post: (type, payload) => posted.push([type, payload]),
  });

  el.querySelector('[data-rel="sub"]').click();
  expect(posted[0]).toEqual(['listDir', { path: 'sub' }]);
});

it('名称与 rootName 只写文本，不注入 HTML', () => {
  const el = JJ.renderTree(
    [{ name: '<img src=x onerror=alert(1)>', isDir: false, relPath: 'x.md' }],
    { rootName: '<b>root</b>', onOpen() {} },
  );

  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(el.getAttribute('aria-label')).toContain('<b>root</b>');
});

// ── 侧栏模式切换 ──

it('setSidebarMode 在 toc/tree 间切换侧栏内容（未知模式按 toc）', () => {
  const { root } = mount();
  const sidebar = root.querySelector('#toc');
  const fileTree = root.querySelector('#file-tree');

  expect(sidebar.dataset.sidebar).toBe('toc');
  expect(fileTree.hidden).toBe(true);
  expect(root.querySelector('#toc-nav').hidden).toBe(false);

  JJ.setSidebarMode('tree');
  expect(sidebar.dataset.sidebar).toBe('tree');
  expect(fileTree.hidden).toBe(false);
  expect(root.querySelector('#toc-nav').hidden).toBe(true);

  JJ.setSidebarMode('toc');
  expect(sidebar.dataset.sidebar).toBe('toc');
  expect(fileTree.hidden).toBe(true);
  expect(root.querySelector('#toc-nav').hidden).toBe(false);

  JJ.setSidebarMode('bogus');
  expect(sidebar.dataset.sidebar).toBe('toc');
});

it('收到根 dirListing 后切到树模式，工具条显示根目录名并可一键回大纲', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\笔记 目录', [
    { name: '子目录', isDir: true, relPath: '子目录' },
    { name: 'a.md', isDir: false, relPath: 'a.md' },
  ]);

  const sidebar = root.querySelector('#toc');
  const browseRoot = root.querySelector('#toolbar #browse-root');
  const treeBack = root.querySelector('#toolbar #tree-back');

  expect(sidebar.dataset.sidebar).toBe('tree');
  expect(root.querySelector('#file-tree li[data-rel="a.md"]')).toBeTruthy();
  expect(browseRoot.hidden).toBe(false);
  expect(browseRoot.textContent).toBe('笔记 目录');
  expect(treeBack.hidden).toBe(false);

  treeBack.click();
  expect(sidebar.dataset.sidebar).toBe('toc');
  expect(treeBack.hidden).toBe(true);
  expect(browseRoot.hidden).toBe(false);

  // 根目录名按钮又能切回文件树（不重新请求宿主）
  browseRoot.click();
  expect(sidebar.dataset.sidebar).toBe('tree');
  expect(treeBack.hidden).toBe(false);
});

// ── dirListing 填充与防重复 ──

it('目录首次点击请求 listDir，收到子列表后填充并标记 data-loaded', () => {
  const { root, shell, posted } = mount();
  sendListing(shell, 'C:\\notes', [{ name: 'sub', isDir: true, relPath: 'sub' }]);

  const parent = findNode(root, 'sub');
  parent.click();
  expect(lastPayload(posted, 'listDir')).toEqual({ path: 'sub' });

  sendListing(shell, 'C:\\notes', [
    { name: 'b.md', isDir: false, relPath: 'sub/b.md' },
  ], 'sub');

  const children = parent.querySelector('ul.tree-children');
  expect(children).toBeTruthy();
  expect(children.hidden).toBe(false);
  expect(parent.getAttribute('data-loaded')).toBe('true');
  expect(parent.getAttribute('data-expanded')).toBe('true');
  expect(parent.querySelector('.tree-toggle').getAttribute('aria-expanded')).toBe('true');
  expect(findNode(root, 'sub/b.md')).toBeTruthy();

  // 折叠再展开：不再重复请求 listDir
  parent.click();
  expect(children.hidden).toBe(true);
  parent.click();
  expect(children.hidden).toBe(false);
  expect(posted.filter((message) => message.type === 'listDir')).toHaveLength(1);
});

it('根 dirListing 替换整棵树，根目录名同步更新', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\one', [{ name: 'a.md', isDir: false, relPath: 'a.md' }]);
  expect(findNode(root, 'a.md')).toBeTruthy();

  sendListing(shell, 'C:\\第二本', [{ name: 'b.md', isDir: false, relPath: 'b.md' }]);

  expect(findNode(root, 'a.md')).toBeNull();
  expect(findNode(root, 'b.md')).toBeTruthy();
  expect(root.querySelector('#toolbar #browse-root').textContent).toBe('第二本');
});

it('根目录为空时显示空态提示', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\空的', []);

  expect(root.querySelector('#toc').dataset.sidebar).toBe('tree');
  expect(root.querySelector('#file-tree .tree-empty')).toBeTruthy();
});

// ── 当前文件高亮与外部文件回落大纲 ──

it('打开树内文件后高亮对应节点；打开树外文件时侧栏回大纲', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\笔记', [
    { name: 'a.md', isDir: false, relPath: 'a.md' },
    { name: 'sub', isDir: true, relPath: 'sub' },
  ]);

  load(shell, { path: 'C:\\笔记\\a.md' });

  const active = findNode(root, 'a.md');
  expect(active.classList.contains('active')).toBe(true);
  expect(active.getAttribute('aria-current')).toBe('true');
  expect(root.querySelector('#toc').dataset.sidebar).toBe('tree');

  // Windows 路径大小写不敏感：load 的 path 与树 relPath 大小写不同也要高亮
  load(shell, { path: 'C:\\笔记\\A.MD' });
  expect(findNode(root, 'a.md').classList.contains('active')).toBe(true);

  // 打开浏览根之外的单文件：恢复大纲模式，但保留浏览根（工具条根名仍在，可再切回树）
  load(shell, { path: 'C:\\其它\\b.md' });

  expect(root.querySelector('#toc').dataset.sidebar).toBe('toc');
  expect(root.querySelectorAll('#file-tree li.active')).toHaveLength(0);
  expect(root.querySelector('#toolbar #browse-root').hidden).toBe(false);
  expect(root.querySelector('#toolbar #tree-back').hidden).toBe(true);
});

it('点击树中文件发送 root + "/" + relPath 的绝对路径（中文与空格原样）', () => {
  const { root, shell, posted } = mount();
  sendListing(shell, 'C:\\笔记 目录', [
    { name: '文件 A.md', isDir: false, relPath: '子目录/文件 A.md' },
  ]);

  findNode(root, '子目录/文件 A.md').click();

  expect(lastPayload(posted, 'openTreeFile')).toEqual({
    path: 'C:\\笔记 目录/子目录/文件 A.md',
  });
});

it('根路径带尾随分隔符时点击文件拼出的绝对路径不出现双分隔符', () => {
  const { root, shell, posted } = mount();
  sendListing(shell, 'C:\\笔记 目录\\', [
    { name: 'a.md', isDir: false, relPath: 'a.md' },
  ]);

  findNode(root, 'a.md').click();

  expect(lastPayload(posted, 'openTreeFile')).toEqual({ path: 'C:\\笔记 目录/a.md' });
});

it('install 暴露 Task 14 的文件树 API', () => {
  for (const name of ['renderTree', 'setSidebarMode', 'applyDirListing', 'setTreeActive']) {
    expect(typeof JJ[name], name).toBe('function');
  }
});
