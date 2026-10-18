// Task 13：打开文件/文件夹入口与 wikilink 寻文件点击。
// 契约：Ctrl+O → pickFile、Ctrl+Shift+O → pickFolder（输入框内不触发）；
// 工具条「打开文件」「打开文件夹」按钮走同一口径；
// #content 委托：.wikilink[data-target] 与 a.attachment[data-target] 点击 preventDefault 后发 openFile{relPath}；
// 图片形式的 .attachment（img，无 data-target）不拦截、不发消息。

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

/** 在 document.body 上派发键盘事件（冒泡到 document 上 shell 的全局监听）。 */
function press(key, modifiers = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  document.body.dispatchEvent(event);
  return event;
}

/** 取某类消息的最后一条 payload；没有则 undefined。 */
function lastPayload(posted, type) {
  const messages = posted.filter((message) => message.type === type);
  return messages.length > 0 ? messages.at(-1).payload : undefined;
}

/** 点击元素并返回事件（断言 defaultPrevented 用）。 */
function click(element) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.innerHTML = '';
});

// ── 快捷键与工具条按钮 ──

it('Ctrl+O 发送 pickFile，Ctrl+Shift+O 发送 pickFolder（大写键名同样识别）', () => {
  const { posted } = mount();

  const open = press('o', { ctrlKey: true });
  expect(open.defaultPrevented).toBe(true);
  expect(posted.filter((message) => message.type === 'pickFile')).toHaveLength(1);

  press('O', { ctrlKey: true, shiftKey: true });
  expect(posted.filter((message) => message.type === 'pickFolder')).toHaveLength(1);
  // 两条消息互不串线：Ctrl+O 不会被 Shift 版本误触发
  expect(posted.filter((message) => message.type === 'pickFile')).toHaveLength(1);

  press('O', { ctrlKey: true }); // Caps Lock 下 key 是大写 O
  expect(posted.filter((message) => message.type === 'pickFile')).toHaveLength(2);
});

it('输入框内不触发 Ctrl+O / Ctrl+Shift+O', () => {
  const { posted } = mount();
  const input = document.createElement('input');
  document.body.append(input);

  for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
    const event = new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true, ...modifiers });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }

  expect(posted.filter((message) => message.type === 'pickFile' || message.type === 'pickFolder')).toHaveLength(0);
});

it('工具条「打开文件」「打开文件夹」按钮发送 pickFile / pickFolder', () => {
  const { root, posted } = mount();
  const openFile = root.querySelector('#toolbar #open-file');
  const openFolder = root.querySelector('#toolbar #open-folder');

  expect(openFile).toBeTruthy();
  expect(openFolder).toBeTruthy();
  expect(openFile.textContent).toBe('打开文件');
  expect(openFolder.textContent).toBe('打开文件夹');

  openFile.click();
  expect(posted.filter((message) => message.type === 'pickFile')).toHaveLength(1);
  openFolder.click();
  expect(posted.filter((message) => message.type === 'pickFolder')).toHaveLength(1);
});

// ── wikilink / 附件点击 ──

it('点击 wikilink 阻止默认跳转并发送 openFile 相对目标（不跳 hash）', () => {
  const { root, shell, posted } = mount();
  load(shell, { markdown: '[[笔记甲|别名]]' });

  const link = root.querySelector('#content a.wikilink');
  expect(link).toBeTruthy();
  expect(link.dataset.target).toBe('笔记甲');
  expect(link.textContent).toBe('别名');

  const event = click(link);

  expect(event.defaultPrevented).toBe(true);
  expect(lastPayload(posted, 'openFile')).toEqual({ relPath: '笔记甲' });
  expect(window.location.hash).toBe('');
});

it('点击非图片附件发送 openFile；图片形式的 .attachment 不触发', () => {
  const { root, shell, posted } = mount();
  load(shell, { markdown: '![[资料.pdf]]\n\n![[图.png]]' });

  const fileLink = root.querySelector('#content a.attachment');
  expect(fileLink).toBeTruthy();
  expect(fileLink.dataset.target).toBe('资料.pdf');
  const fileEvent = click(fileLink);
  expect(fileEvent.defaultPrevented).toBe(true);
  expect(lastPayload(posted, 'openFile')).toEqual({ relPath: '资料.pdf' });
  expect(posted.filter((message) => message.type === 'openFile')).toHaveLength(1);

  const image = root.querySelector('#content img.attachment');
  expect(image).toBeTruthy();
  expect(image.hasAttribute('data-target')).toBe(false);
  const imageEvent = click(image);
  expect(imageEvent.defaultPrevented).toBe(false);
  expect(posted.filter((message) => message.type === 'openFile')).toHaveLength(1);
});

it('普通外链点击不被 wikilink 委托接管（照常新窗口打开）', () => {
  const { root, shell, posted } = mount();
  load(shell, { markdown: '[外链](https://example.com/x)' });

  const link = root.querySelector('#content a[href^="https://example.com"]');
  expect(link).toBeTruthy();
  const event = click(link);

  expect(event.defaultPrevented).toBe(false);
  expect(posted.filter((message) => message.type === 'openFile')).toHaveLength(0);
});
