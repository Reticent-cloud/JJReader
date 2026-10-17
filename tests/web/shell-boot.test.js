// shell 启动骨架：mountShell 建固定 DOM、load → renderDone 回报、shellReady 握手、toast 与容错。
// Task 5 起正文走 JJ.renderMarkdown（真实 markdown 引擎）；引擎缺失时降级 escapeHtml + <pre> 兜底。

/** 每个用例独立的 #app 容器（mountShell 的 root 就是 #app 本身）。 */
function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

/** 用收集器代替宿主 post，返回 shell 与已发送消息。 */
function mount(root) {
  const posted = [];
  const shell = JJ.mountShell({
    root,
    post: (type, payload) => posted.push({ type, payload }),
  });
  return { shell, posted };
}

function loadPayload(overrides = {}) {
  return {
    path: 'a.md',
    key: 'k',
    baseUrl: 'https://md.local/',
    markdown: '# 标题\n正文',
    settings: {},
    position: null,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

it('渲染 markdown 并回报 renderDone', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
  shell.onMessage({
    type: 'load',
    payload: {
      path: 'a.md',
      key: 'k',
      baseUrl: 'https://md.local/',
      markdown: '# 标题\n正文',
      settings: {},
      position: null,
    },
  });
  const done = posted.find((m) => m.type === 'renderDone');
  expect(done.payload.path).toBe('a.md');
  expect(done.payload.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(root.querySelector('#content').innerHTML).toContain('标题');
});

it('mountShell 建立固定骨架并立即发出一次 shellReady', () => {
  const root = createRoot();
  const { posted } = mount(root);

  // 骨架：#app > header#toolbar、aside#toc、main#content、div#toast
  expect(root.querySelector('header#toolbar')).toBeTruthy();
  expect(root.querySelector('aside#toc')).toBeTruthy();
  expect(root.querySelector('main#content')).toBeTruthy();
  expect(root.querySelector('div#toast')).toBeTruthy();

  // 握手：mount 完成后立刻且只发一次 shellReady（宿主收到后才推送 load）
  const ready = posted.filter((m) => m.type === 'shellReady');
  expect(ready).toHaveLength(1);
});

it('renderDone 携带 path/elapsedMs/tocCount/bytes', () => {
  const root = createRoot();
  const { shell, posted } = mount(root);

  shell.onMessage({ type: 'load', payload: loadPayload({ markdown: '# 甲\n\n乙' }) });

  const done = posted.find((m) => m.type === 'renderDone');
  expect(done).toBeTruthy();
  // 契约（spec §4.4）：{path, elapsedMs, tocCount, bytes}；T5 接真引擎后 tocCount 是真实标题数（'# 甲' → 1）
  expect(done.payload).toMatchObject({ path: 'a.md', tocCount: 1 });
  expect(done.payload.elapsedMs).toBeGreaterThanOrEqual(0);
  // bytes 是 markdown 文本的 UTF-8 字节数：'#'+' '+甲+换行+换行+乙 = 1+1+3+1+1+3
  expect(done.payload.bytes).toBe(10);
});

it('toast 消息创建可见提示', () => {
  const root = createRoot();
  const { shell } = mount(root);

  shell.onMessage({ type: 'toast', payload: { text: '文件编码可能不是 UTF-8', level: 'warn' } });

  const container = root.querySelector('#toast');
  expect(container.hidden).toBe(false);
  expect(container.textContent).toContain('文件编码可能不是 UTF-8');
  expect(container.querySelector('.toast')).toBeTruthy();
});

it('连续 toast 追加多条提示', () => {
  const root = createRoot();
  const { shell } = mount(root);

  shell.onMessage({ type: 'toast', payload: { text: '第一条' } });
  shell.onMessage({ type: 'toast', payload: { text: '第二条' } });

  expect(root.querySelectorAll('#toast .toast')).toHaveLength(2);
  expect(root.querySelector('#toast').textContent).toContain('第二条');
});

it('引擎缺失时降级 <pre> 转义渲染，不白屏', () => {
  const root = createRoot();
  const { shell } = mount(root);
  const original = JJ.renderMarkdown;

  try {
    // 模拟引擎未装配（打包缺失/加载失败）：shell 必须走 escapeHtml 兜底，原文不能当作 HTML 执行
    delete JJ.renderMarkdown;
    shell.onMessage({
      type: 'load',
      payload: loadPayload({ markdown: '<img src=x onerror=alert(1)>' }),
    });
  } finally {
    JJ.renderMarkdown = original;
  }

  const html = root.querySelector('#content').innerHTML;
  expect(html).toContain('jj-fallback');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
});

it('onMessage 对未知 type 与畸形消息不抛异常', () => {
  const root = createRoot();
  const { shell } = mount(root);

  expect(() => shell.onMessage({ type: 'bogus', payload: {} })).not.toThrow();
  expect(() => shell.onMessage(null)).not.toThrow();
  expect(() => shell.onMessage({})).not.toThrow();
  expect(() => shell.onMessage({ type: 'assocState', payload: { registered: true, isDefault: false } })).not.toThrow();
  expect(() => shell.onMessage({ type: 'dirListing', payload: { path: 'C:\\', entries: [] } })).not.toThrow();
});
