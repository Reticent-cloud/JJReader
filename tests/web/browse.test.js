// Task 14 评审修复：文件夹浏览的边界行为——长路径（宿主 >255 会加 \\?\ 前缀）仍判定在浏览根内、
// 切根竞态下旧根子列表晚到被丢弃、目录展开失败后单击即可重试、在途折叠不被晚到列表强行展开。
// 全部通过 shell 的公开消息契约（load / dirListing / toast）驱动，不直接调用内部模块。

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

/** 推一条宿主 toast（读取目录失败时宿主只发 toast，不回 dirListing）。 */
function toast(shell, text, level = 'warn') {
  shell.onMessage({ type: 'toast', payload: { text, level } });
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

// ── Important：长路径（>255）document path 带 \\?\，root 仍是短路径 ──

it('长路径文档（\\?\ 前缀）仍判定在短根内：保持树模式并高亮', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\notes', [{ name: 'a.md', isDir: false, relPath: 'deep/a.md' }]);

  // 宿主 FileHost.NormalizePath 对 >255 的路径加 \\?\，load 里就是带前缀形式；树根是短路径。
  load(shell, { path: '\\\\?\\C:\\notes\\deep\\a.md' });

  const node = findNode(root, 'deep/a.md');
  expect(root.querySelector('#toc').dataset.sidebar).toBe('tree');
  expect(node).toBeTruthy();
  expect(node.classList.contains('active')).toBe(true);
  expect(node.getAttribute('aria-current')).toBe('true');
});

it('UNC 长路径（\\?\UNC\ 前缀）与普通 UNC 根等价', () => {
  const { root, shell } = mount();
  sendListing(shell, '\\\\server\\share\\notes', [
    { name: 'a.md', isDir: false, relPath: 'a.md' },
  ]);

  load(shell, { path: '\\\\?\\UNC\\server\\share\\notes\\a.md' });

  const node = findNode(root, 'a.md');
  expect(root.querySelector('#toc').dataset.sidebar).toBe('tree');
  expect(node.classList.contains('active')).toBe(true);
});

it('带 \\?\ 前缀的浏览根与普通 load path 也按同一根比较', () => {
  const { root, shell } = mount();
  sendListing(shell, '\\\\?\\C:\\notes', [{ name: 'a.md', isDir: false, relPath: 'a.md' }]);

  load(shell, { path: 'C:\\notes\\a.md' });

  expect(findNode(root, 'a.md').classList.contains('active')).toBe(true);
});

// ── Minor 2：切根竞态，旧根子列表晚到 ──

it('切根后晚到的旧根子列表被丢弃，不填进新树的同名目录', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\old', [{ name: 'sub', isDir: true, relPath: 'sub' }]);
  sendListing(shell, 'C:\\new', [{ name: 'sub', isDir: true, relPath: 'sub' }]);

  // 旧根的子列表比新根列表晚到：root 不一致，必须丢弃（新树里恰好也有同名 sub 节点）
  sendListing(shell, 'C:\\old', [{ name: 'stale.md', isDir: false, relPath: 'sub/stale.md' }], 'sub');

  const sub = findNode(root, 'sub');
  expect(findNode(root, 'sub/stale.md')).toBeNull();
  expect(sub.getAttribute('data-loaded')).toBeNull();

  // 新根同一路径的子列表照常应用
  sendListing(shell, 'C:\\new', [{ name: 'fresh.md', isDir: false, relPath: 'sub/fresh.md' }], 'sub');
  expect(findNode(root, 'sub/fresh.md')).toBeTruthy();
  expect(sub.getAttribute('data-loaded')).toBe('true');
});

it('大小写不同的同一根（盘符/目录名）不算切根', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\Notes', [{ name: 'sub', isDir: true, relPath: 'sub' }]);

  sendListing(shell, 'c:\\notes', [{ name: 'b.md', isDir: false, relPath: 'sub/b.md' }], 'sub');

  expect(findNode(root, 'sub/b.md')).toBeTruthy();
});

// ── Minor 3：目录展开失败后单击重试 ──

it('目录展开失败（宿主 warn toast）后清除在途标记，单击即可重试', () => {
  const { root, shell, posted } = mount();
  sendListing(shell, 'C:\\notes', [{ name: 'sub', isDir: true, relPath: 'sub' }]);
  const sub = findNode(root, 'sub');

  sub.click();
  expect(lastPayload(posted, 'listDir')).toEqual({ path: 'sub' });
  expect(sub.getAttribute('data-requested')).toBe('true');

  // 宿主读取失败只发 toast，不会回 dirListing
  toast(shell, '无法读取该目录', 'warn');
  expect(sub.getAttribute('data-requested')).toBeNull();
  expect(sub.getAttribute('data-failed')).toBe('true');
  expect(sub.getAttribute('data-expanded')).toBe('false');

  // 不用先折叠再展开：单击一次就重新请求
  sub.click();
  expect(posted.filter((message) => message.type === 'listDir')).toHaveLength(2);
  expect(sub.getAttribute('data-expanded')).toBe('true');
  expect(sub.getAttribute('data-failed')).toBeNull();
});

// ── Minor 4：晚到子列表保留当前折叠状态 ──

it('请求在途时折叠目录，晚到的子列表填充但不强行展开', () => {
  const { root, shell } = mount();
  sendListing(shell, 'C:\\notes', [{ name: 'sub', isDir: true, relPath: 'sub' }]);
  const sub = findNode(root, 'sub');

  sub.click(); // 展开并请求
  sub.click(); // 折叠（在途标记被清除，方便失败后重试）
  expect(sub.getAttribute('data-expanded')).toBe('false');

  sendListing(shell, 'C:\\notes', [{ name: 'b.md', isDir: false, relPath: 'sub/b.md' }], 'sub');

  expect(findNode(root, 'sub/b.md')).toBeTruthy();
  expect(sub.getAttribute('data-loaded')).toBe('true');
  expect(sub.getAttribute('data-expanded')).toBe('false');
  expect(sub.querySelector('ul.tree-children').hidden).toBe(true);
});
