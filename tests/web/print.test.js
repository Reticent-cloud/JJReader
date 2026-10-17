// Task 15：PDF 导出打印模式（print.js）与导出入口（Ctrl+E / 工具条按钮）。
// 打印模式只切换 body.print-mode 与 data-theme（不拼 HTML）；退出必须恢复原主题并移除 class。
// 导出消息只在有当前文档时发送，suggestedName = 当前文档文件名去扩展名 + .pdf。

const mounted = [];

/** 每个用例独立的 #app 容器（mountShell 的 root 就是 #app 本身）。 */
function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

/** 装配 shell，返回 { root, shell, posted }；destroy 在 afterEach 统一调用，避免监听器泄漏。 */
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
      path: 'a.md',
      key: 'k',
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
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  document.body.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  delete window.__jjPrintExit;
  delete JJ.__post;
  delete window.chrome;
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  // 用例失败时也要退出打印模式，避免模块级状态污染后续文件
  JJ.exitPrintModeForPdf();
  document.body.classList.remove('print-mode');
  delete window.__jjPrintExit;
  vi.restoreAllMocks();
});

it('打印模式隐藏工具条与侧栏并强制浅色', () => {
  document.body.innerHTML = '<header id="toolbar"></header><aside id="toc"></aside><main id="content">x</main>';
  const exit = JJ.enterPrintMode({ document });
  expect(document.body.classList.contains('print-mode')).toBe(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  exit();
  expect(document.body.classList.contains('print-mode')).toBe(false);
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
});

it('导出流程：进入打印模式后回报 readyToPrint', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type) => posted.push(type) });
  mounted.push(shell);
  JJ.enterPrintModeForPdf();
  expect(posted).toContain('readyToPrint');
  expect(typeof window.__jjPrintExit).toBe('function');
  JJ.exitPrintModeForPdf();
  expect(window.__jjPrintExit).toBeUndefined();
});

it('退出打印模式恢复原主题（原深色时）', () => {
  document.body.innerHTML = '<main id="content">x</main>';
  document.documentElement.dataset.theme = 'dark';
  const exit = JJ.enterPrintMode({ document });
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.body.classList.contains('print-mode')).toBe(true);

  exit();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.body.classList.contains('print-mode')).toBe(false);
});

it('消息通道缺失时不抛，只打日志', () => {
  document.body.innerHTML = '<main id="content">x</main>';
  document.documentElement.dataset.theme = 'dark';
  delete JJ.__post;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  expect(() => JJ.enterPrintModeForPdf()).not.toThrow();
  expect(document.body.classList.contains('print-mode')).toBe(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(warn).toHaveBeenCalled();

  JJ.exitPrintModeForPdf();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.body.classList.contains('print-mode')).toBe(false);
});

it('enterPrintMode 重复调用幂等（原主题只记一次）', () => {
  document.documentElement.dataset.theme = 'dark';
  const first = JJ.enterPrintMode({ document });
  const second = JJ.enterPrintMode({ document });
  expect(document.body.classList.contains('print-mode')).toBe(true);
  expect(document.documentElement.dataset.theme).toBe('light');

  second();
  expect(document.body.classList.contains('print-mode')).toBe(false);
  expect(document.documentElement.dataset.theme).toBe('dark');

  // 再次退出是空操作，不会把主题改成 light
  expect(() => first()).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('工具条「导出 PDF」按钮在有文档时发送 exportPdf', () => {
  const { root, shell, posted } = mount();
  const button = root.querySelector('#export-pdf');
  expect(button).toBeTruthy();
  expect(button.disabled).toBe(true);

  load(shell, { path: 'D:\\资料\\中文 笔记.md' });
  expect(button.disabled).toBe(false);
  button.click();

  const message = posted.findLast((item) => item.type === 'exportPdf');
  expect(message).toBeTruthy();
  expect(message.payload).toEqual({ suggestedName: '中文 笔记.pdf' });
});

it('Ctrl+E 发送 exportPdf，suggestedName 由当前文档名去扩展名生成', () => {
  const { shell, posted } = mount();
  load(shell, { path: 'D:\\资料\\中文 笔记.md' });

  const event = press('e', { ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  const message = posted.findLast((item) => item.type === 'exportPdf');
  expect(message).toBeTruthy();
  expect(message.payload).toEqual({ suggestedName: '中文 笔记.pdf' });
});

it('无当前文档时 Ctrl+E 不发送 exportPdf，并提示先打开文档', () => {
  const { root, posted } = mount();
  const event = press('e', { ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(posted.some((item) => item.type === 'exportPdf')).toBe(false);
  const toast = root.querySelector('#toast .toast');
  expect(toast).toBeTruthy();
  expect(toast.textContent).toContain('请先打开文档');
});
