// 复制按钮反馈（用户反馈修复）：点击后只闪一下（data-copied / data-failed 260ms 后自动清除），
// 同时派发 document 级 jj:copy 事件，由 shell 弹「已复制 / 复制失败」toast。
// 全部使用 fake timers：复制流程是 Promise + setTimeout 两段异步，靠 advanceTimersByTimeAsync 推进。

const BASE_URL = 'https://md.local/';

/** 渲染代码块并挂到 body（enhance 作用于已渲染子树）。 */
function renderRoot(markdown) {
  const root = document.createElement('div');
  root.innerHTML = JJ.renderMarkdown(markdown, { baseUrl: BASE_URL });
  document.body.append(root);
  return root;
}

/** 给 navigator.clipboard 装桩（jsdom 默认没有 clipboard）。 */
function stubClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

/** 收集 document 上的 jj:copy 事件 detail。 */
function collectCopyEvents() {
  const events = [];
  const listener = (event) => events.push(event.detail);
  document.addEventListener('jj:copy', listener);
  return {
    events,
    stop: () => document.removeEventListener('jj:copy', listener),
  };
}

const mounted = [];

function mountShell() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const shell = JJ.mountShell({ root, post: () => {} });
  mounted.push(shell);
  return { root, shell };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  vi.useRealTimers();
  delete navigator.clipboard;
  delete document.execCommand;
});

it('复制成功：立即 data-copied=1 + jj:copy{ok:true}，260ms 后属性自动移除', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard(writeText);
  const root = renderRoot('```js\nlet x=1;\n```');
  JJ.enhance(root);
  const copyEvents = collectCopyEvents();
  const btn = root.querySelector('button.copy');

  try {
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(btn.dataset.copied).toBe('1');
    expect(btn.dataset.failed).toBeUndefined();
    expect(copyEvents.events).toEqual([{ ok: true }]);

    // 260ms 内仍保持闪烁态
    await vi.advanceTimersByTimeAsync(200);
    expect(btn.dataset.copied).toBe('1');

    // 260ms 到点后属性被清除，按钮不再长期高亮
    await vi.advanceTimersByTimeAsync(100);
    expect(btn.dataset.copied).toBeUndefined();
    expect(btn.dataset.failed).toBeUndefined();
  } finally {
    copyEvents.stop();
  }
});

it('复制失败：data-failed + jj:copy{ok:false}，260ms 后同样清除', async () => {
  stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
  delete document.execCommand; // 无 execCommand 兜底 → 复制失败
  const root = renderRoot('```js\nlet x=1;\n```');
  JJ.enhance(root);
  const copyEvents = collectCopyEvents();
  const btn = root.querySelector('button.copy');

  try {
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.dataset.failed).toBe('1');
    expect(btn.dataset.copied).toBeUndefined();
    expect(copyEvents.events).toEqual([{ ok: false }]);

    await vi.advanceTimersByTimeAsync(300);
    expect(btn.dataset.failed).toBeUndefined();
  } finally {
    copyEvents.stop();
  }
});

it('同一按钮连续点击会重置清除计时器（不会提前熄灭）', async () => {
  stubClipboard(vi.fn().mockResolvedValue(undefined));
  const root = renderRoot('```js\nlet x=1;\n```');
  JJ.enhance(root);
  const btn = root.querySelector('button.copy');

  btn.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(btn.dataset.copied).toBe('1');

  await vi.advanceTimersByTimeAsync(200); // 第一次点击后 200ms
  btn.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(btn.dataset.copied).toBe('1');

  await vi.advanceTimersByTimeAsync(200); // 距第一次 400ms，但计时器已重置
  expect(btn.dataset.copied).toBe('1');

  await vi.advanceTimersByTimeAsync(100); // 第二次点击后 300ms
  expect(btn.dataset.copied).toBeUndefined();
});

it('shell 收到 jj:copy 后 #toast 显示「已复制」', async () => {
  const { root, shell } = mountShell();
  shell.onMessage({
    type: 'load',
    payload: {
      path: 'a.md',
      key: 'k',
      baseUrl: BASE_URL,
      markdown: '```js\nlet x=1;\n```',
      settings: {},
      position: null,
    },
  });

  stubClipboard(vi.fn().mockResolvedValue(undefined));
  const btn = root.querySelector('#content button.copy');
  expect(btn).toBeTruthy();

  btn.click();
  await vi.advanceTimersByTimeAsync(0);

  const toast = root.querySelector('#toast .toast-text');
  expect(toast).toBeTruthy();
  expect(toast.textContent).toBe('已复制');
  expect(root.querySelector('#toast').hidden).toBe(false);
});

it('shell 收到失败事件后 #toast 显示「复制失败」（warn）', async () => {
  const { root, shell } = mountShell();
  shell.onMessage({
    type: 'load',
    payload: {
      path: 'a.md',
      key: 'k',
      baseUrl: BASE_URL,
      markdown: '```js\nlet x=1;\n```',
      settings: {},
      position: null,
    },
  });

  stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
  delete document.execCommand;
  root.querySelector('#content button.copy').click();
  await vi.advanceTimersByTimeAsync(0);

  const toast = root.querySelector('#toast .toast-text');
  expect(toast.textContent).toBe('复制失败');
  expect(toast.parentElement.dataset.level).toBe('warn');
});
