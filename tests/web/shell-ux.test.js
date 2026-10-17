// Task 12：最近文件面板、位置记忆与工具条交互（shell-ux）。
// jsdom 没有真实布局/滚动：scrollTop / scrollHeight / clientHeight 一律用 Object.defineProperty 桩，
// scrollTo 用函数替换；位置节流 500ms 与工具条 800ms 自动隐藏用 fake timers（vi.useFakeTimers）。
// 契约：最近文件 20 条、位置节流 500ms、回到顶部阈值 400px、工具条隐藏延迟 800ms。

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
      path: 'a.md',
      key: 'key-a',
      baseUrl: 'https://md.local/',
      markdown: '# 甲\n\n## 乙',
      settings: {},
      position: null,
      ...overrides,
    },
  });
}

/** 最近文件条目（宿主 recent 消息的字段）。 */
function recentItem(path, name) {
  return { path, name, dir: 'C:\\notes', openedAt: '' };
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

/** 桩滚动容器尺寸与可写 scrollTop；返回句柄（jsdom 默认 scrollTop 恒 0、尺寸恒 0）。 */
function stubScroll(element, { scrollHeight = 0, clientHeight = 0, scrollTop = 0 } = {}) {
  let value = scrollTop;
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next;
    },
  });
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

/** document.visibilityState 桩（jsdom 只读为 visible）；返回恢复函数。 */
function stubVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  return () => {
    delete document.visibilityState;
  };
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  delete window.matchMedia;
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// ── 公开 API ──

it('install 暴露最近文件、位置追踪、toast 与阅读 chrome API', () => {
  for (const name of ['renderRecent', 'createPositionTracker', 'showToast', 'updateChrome']) {
    expect(typeof JJ[name], name).toBe('function');
  }
});

// ── 最近文件面板 ──

it('最近文件面板渲染按钮（显示名/目录/相对时间），最多 20 项', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  const el = JJ.renderRecent([
    { path: 'C:\\a.md', name: 'a.md', dir: 'C:\\', openedAt: '2026-10-17T09:12:00Z' },
    { path: 'C:\\b.md', name: 'b.md', dir: 'C:\\', openedAt: '' },
  ]);
  expect(el.querySelectorAll('[data-path]')).toHaveLength(2);
  expect(el.querySelector('.recent-title').textContent).toBe('最近文件');
  expect(el.querySelector('.recent-name').textContent).toBe('a.md');
  expect(el.querySelector('.recent-dir').textContent).toBe('C:\\');
  expect(el.querySelector('.recent-time').textContent).toBe('2 小时前');
  // openedAt 为空：不渲染时间标签
  expect(el.querySelectorAll('.recent-time')).toHaveLength(1);

  const many = JJ.renderRecent(
    Array.from({ length: 25 }, (_, index) => recentItem(`C:\\${index}.md`, `${index}.md`)),
  );
  expect(many.querySelectorAll('[data-path]')).toHaveLength(20);
  vi.useRealTimers();
});

it('空最近列表显示「还没有打开过文档」与打开提示', () => {
  const el = JJ.renderRecent([]);
  expect(el.querySelectorAll('[data-path]')).toHaveLength(0);
  expect(el.querySelector('.recent-empty').textContent).toBe('还没有打开过文档');
  expect(el.textContent).toContain('最近文件');
  expect(el.textContent).toContain('拖入 .md 或 Ctrl+O 打开');
});

it('最近文件面板 ↑↓ 移动焦点、Enter/点击打开、Esc 触发关闭回调', () => {
  const opened = [];
  const closed = [];
  const el = JJ.renderRecent(
    [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')],
    { onOpen: (path) => opened.push(path), onClose: () => closed.push(1) },
  );
  document.body.append(el);
  const buttons = [...el.querySelectorAll('[data-path]')];

  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[1]);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(opened).toEqual(['C:\\b.md']);

  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  buttons[0].click();
  expect(opened.at(-1)).toBe('C:\\a.md');

  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(closed).toHaveLength(1);
});

it('最近文件键盘事件直接派发在面板上（不冒泡）也能处理', () => {
  // 计划里的原始用例写法：new KeyboardEvent('keydown', { key }) 直接派发到容器
  const opened = [];
  const el = JJ.renderRecent([recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')], {
    onOpen: (path) => opened.push(path),
  });
  expect(el.querySelectorAll('[data-path]')).toHaveLength(2);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(opened).toEqual(['C:\\a.md']);
});

// ── 位置追踪 ──

it('位置上报节流 500ms，且比例不变不重复发', () => {
  vi.useFakeTimers();
  const sent = [];
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 2000, clientHeight: 1000 });
  const tracker = JJ.createPositionTracker({
    scroller,
    key: 'k',
    emit: (key, ratio) => sent.push([key, ratio]),
  });
  tracker.start();

  scroll.set(500);
  scroller.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(499);
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(sent).toEqual([['k', 0.5]]);

  // 同一比例：不重复上报
  scroller.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(500);
  expect(sent).toEqual([['k', 0.5]]);

  scroll.set(1000);
  scroller.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(500);
  expect(sent).toEqual([
    ['k', 0.5],
    ['k', 1],
  ]);
  tracker.destroy();
  vi.useRealTimers();
});

it('flush 立即发出（与上次相同也发），destroy 后解绑滚动与页面事件', () => {
  vi.useFakeTimers();
  const sent = [];
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 2000, clientHeight: 1000 });
  const tracker = JJ.createPositionTracker({
    scroller,
    key: 'k',
    emit: (key, ratio) => sent.push([key, ratio]),
  });
  tracker.start();
  scroll.set(500);
  tracker.flush();
  expect(sent).toEqual([['k', 0.5]]);
  tracker.flush();
  expect(sent).toHaveLength(2); // 相同比例也发（关窗前强制落盘）

  tracker.destroy();
  scroll.set(1000);
  scroller.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event('pagehide'));
  tracker.flush();
  expect(sent).toHaveLength(2);
  vi.useRealTimers();
});

it('pagehide 与页面隐藏时强制 flush 当前位置', () => {
  vi.useFakeTimers();
  const sent = [];
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 2000, clientHeight: 1000 });
  const tracker = JJ.createPositionTracker({
    scroller,
    key: 'k',
    emit: (key, ratio) => sent.push([key, ratio]),
  });
  tracker.start();

  scroll.set(500);
  window.dispatchEvent(new Event('pagehide'));
  expect(sent).toEqual([['k', 0.5]]);

  const restore = stubVisibility('visible');
  try {
    scroll.set(1000);
    document.dispatchEvent(new Event('visibilitychange')); // visible：不 flush
    expect(sent).toHaveLength(1);
  } finally {
    restore();
  }

  const restoreHidden = stubVisibility('hidden');
  try {
    scroll.set(1000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent.at(-1)).toEqual(['k', 1]);
  } finally {
    restoreHidden();
  }
  tracker.destroy();
  vi.useRealTimers();
});

it('位置比例夹紧到 [0,1]', () => {
  vi.useFakeTimers();
  const sent = [];
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 1000 }); // 不可滚动：分母兜底 1
  const tracker = JJ.createPositionTracker({ scroller, key: 'k', emit: (key, ratio) => sent.push([key, ratio]) });
  tracker.start();
  scroll.set(50);
  tracker.flush();
  expect(sent).toEqual([['k', 1]]); // 50 / max(1, 0) 夹到 1
  tracker.destroy();
  vi.useRealTimers();
});

// ── 进度条 / 回到顶部 ──

it('updateChrome 写进度条宽度百分比，并按 400px 阈值显隐回到顶部', () => {
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 3000, clientHeight: 800 });
  const progressEl = document.createElement('div');
  const backToTopEl = document.createElement('button');
  backToTopEl.hidden = true;
  const calls = [];
  scroller.scrollTo = (options) => calls.push(options);

  scroll.set(100);
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  expect(backToTopEl.hidden).toBe(true);
  expect(parseFloat(progressEl.style.width)).toBeCloseTo((100 / 2200) * 100, 2);
  expect(progressEl.style.width.endsWith('%')).toBe(true);

  scroll.set(900);
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  expect(backToTopEl.hidden).toBe(false);
  expect(parseFloat(progressEl.style.width)).toBeCloseTo((900 / 2200) * 100, 2);

  // 点击回到顶部：平滑滚到 0；重复 updateChrome 不会重复绑定
  backToTopEl.click();
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  backToTopEl.click();
  expect(calls).toEqual([
    { top: 0, behavior: 'smooth' },
    { top: 0, behavior: 'smooth' },
  ]);
});

it('updateChrome 在不可滚动容器上进度为 0，阈值可配置', () => {
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 500, clientHeight: 500 });
  const progressEl = document.createElement('div');
  const backToTopEl = document.createElement('button');
  JJ.updateChrome({ scroller, progressEl, backToTopEl, thresholdPx: 0 });
  expect(parseFloat(progressEl.style.width)).toBe(0);
  expect(backToTopEl.hidden).toBe(true);

  // 不可滚动容器的分母兜底为 1：scrollTop > 0 时比例夹紧到 1
  scroll.set(1);
  JJ.updateChrome({ scroller, progressEl, backToTopEl, thresholdPx: 0 });
  expect(parseFloat(progressEl.style.width)).toBe(100);
  expect(backToTopEl.hidden).toBe(false);
});

// ── toast ──

it('showToast 默认 3 秒后自动消失', () => {
  vi.useFakeTimers();
  JJ.showToast('提示');
  const container = document.querySelector('#toast');
  expect(container).toBeTruthy();
  expect(container.hidden).toBe(false);
  expect(container.querySelector('.toast')).toBeTruthy();
  vi.advanceTimersByTime(3000);
  expect(document.querySelector('.toast')).toBeFalsy();
  expect(container.hidden).toBe(true);
  vi.useRealTimers();
});

it('showToast 支持自定义时长与可点击 action', () => {
  vi.useFakeTimers();
  const onAction = vi.fn();
  JJ.showToast('已回到上次位置 · 回到顶部', 'info', { durationMs: 5000, actionText: '回到顶部', onAction });
  const action = document.querySelector('.toast button');
  expect(action).toBeTruthy();
  expect(action.textContent).toBe('回到顶部');

  vi.advanceTimersByTime(3000);
  expect(document.querySelector('.toast')).toBeTruthy(); // 自定义 5s 还没到
  action.click();
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.toast')).toBeFalsy();
  vi.useRealTimers();
});

it('shell 的 toast 消息进入 #toast，并在 3 秒后消失', () => {
  vi.useFakeTimers();
  const { root, shell } = mount();
  shell.onMessage({ type: 'toast', payload: { text: '提示', level: 'warn' } });
  const toast = root.querySelector('#toast .toast');
  expect(toast).toBeTruthy();
  expect(toast.dataset.level).toBe('warn');
  vi.advanceTimersByTime(3000);
  expect(root.querySelector('#toast .toast')).toBeFalsy();
  vi.useRealTimers();
});

// ── 空白启动：最近文件面板 ──

it('空白启动显示最近文件面板，recent 消息刷新列表，load 后隐藏', () => {
  const { root, shell } = mount();
  expect(root.querySelector('#content .recent-panel')).toBeTruthy();
  expect(root.querySelector('#content .recent-empty').textContent).toBe('还没有打开过文档');
  expect(root.querySelector('#content').textContent).toContain('拖入 .md 或 Ctrl+O 打开');

  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')] },
  });
  expect(root.querySelectorAll('#content .recent-panel [data-path]')).toHaveLength(2);

  load(shell);
  expect(root.querySelector('#content .recent-panel')).toBeNull();
  expect(root.querySelector('#content h1')).toBeTruthy();

  // 文档已打开：后续 recent 消息只更新 state，不把面板塞回正文
  shell.onMessage({ type: 'recent', payload: { items: [recentItem('C:\\b.md', 'b.md')] } });
  expect(root.querySelector('#content .recent-panel')).toBeNull();
});

it('空白页最近文件项点击/Enter 发送 openFile 绝对路径，Esc 关闭面板', () => {
  const { root, shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')] },
  });
  const panel = root.querySelector('#content .recent-panel');
  panel.querySelectorAll('[data-path]')[1].click();
  expect(lastPayload(posted, 'openFile')).toEqual({ relPath: 'C:\\b.md' });

  press('Escape');
  expect(root.querySelector('#content .recent-panel')).toBeNull();
});

// ── 位置恢复 ──

it('load 带 position 时恢复 scrollTop 并提示「已回到上次位置 · 回到顶部」', () => {
  const { root, shell } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 2000, clientHeight: 1000 });
  const calls = [];
  content.scrollTo = (options) => calls.push(options);

  load(shell, { position: 0.5 });
  expect(scroll.get()).toBe(500);
  expect(parseFloat(root.querySelector('#progress-bar').style.width)).toBeCloseTo(50, 2);

  const toast = root.querySelector('#toast .toast');
  expect(toast).toBeTruthy();
  expect(toast.textContent).toContain('已回到上次位置 · 回到顶部');
  const action = toast.querySelector('button');
  expect(action.textContent).toBe('回到顶部');
  action.click();
  expect(calls).toEqual([{ top: 0, behavior: 'smooth' }]);
});

it('load 无 position 时回到顶部，不沿用旧滚动位置', () => {
  const { root, shell } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 2000, clientHeight: 1000, scrollTop: 800 });

  load(shell, { position: null });
  expect(scroll.get()).toBe(0);
  expect(root.querySelector('#toast .toast')).toBeNull();
});

it('load 的 position 超出 [0,1] 时夹紧', () => {
  const { root, shell } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 2000, clientHeight: 1000 });
  load(shell, { position: 3 });
  expect(scroll.get()).toBe(1000);
});

// ── 滚动驱动 chrome 与位置上报 ──

it('滚动驱动进度条与回到顶部，并按 500ms 节流发 savePosition', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 3000, clientHeight: 800 });
  load(shell, { key: 'key-1', position: null });

  scroll.set(900);
  content.dispatchEvent(new Event('scroll'));
  expect(root.querySelector('#back-to-top').hidden).toBe(false);
  expect(parseFloat(root.querySelector('#progress-bar').style.width)).toBeCloseTo((900 / 2200) * 100, 2);
  expect(posted.filter((message) => message.type === 'savePosition')).toHaveLength(0);

  vi.advanceTimersByTime(500);
  const saved = lastPayload(posted, 'savePosition');
  expect(saved.key).toBe('key-1');
  expect(saved.ratio).toBeCloseTo(900 / 2200, 5);
  vi.useRealTimers();
});

it('pagehide 时 shell 强制 flush 位置', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 2000, clientHeight: 1000 });
  load(shell, { key: 'key-1' });
  scroll.set(250);
  window.dispatchEvent(new Event('pagehide'));
  expect(lastPayload(posted, 'savePosition')).toEqual({ key: 'key-1', ratio: 0.25 });
  vi.useRealTimers();
});

// ── 快捷键：最近文件切换 / 重载 / 定位文件 ──

it('Alt+←/→ 按最近文件列表切换（← 上一份更早，→ 更新）', () => {
  const { shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\b.md', 'b.md'), recentItem('C:\\a.md', 'a.md')] },
  });
  load(shell, { path: 'C:\\b.md' }); // 最近列表第 0 项（最新）
  press('ArrowLeft', { altKey: true }); // 上一份（更早）= 第 1 项
  expect(lastPayload(posted, 'openFile')).toEqual({ relPath: 'C:\\a.md' });

  load(shell, { path: 'C:\\a.md' }); // 第 1 项
  press('ArrowRight', { altKey: true }); // 下一份（更新）= 第 0 项
  expect(lastPayload(posted, 'openFile')).toEqual({ relPath: 'C:\\b.md' });

  load(shell, { path: 'C:\\b.md' }); // 已在最新：再「下一份」无动作
  const before = posted.filter((message) => message.type === 'openFile').length;
  press('ArrowRight', { altKey: true });
  expect(posted.filter((message) => message.type === 'openFile')).toHaveLength(before);
});

it('F5 先 flush 位置再请求重载', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 2000, clientHeight: 1000 });
  load(shell, { key: 'key-1', position: null });
  scroll.set(500);
  content.dispatchEvent(new Event('scroll')); // 节流中的待发位置

  press('F5');
  const types = posted.map((message) => message.type);
  expect(types.slice(-2)).toEqual(['savePosition', 'reload']);
  expect(lastPayload(posted, 'savePosition')).toEqual({ key: 'key-1', ratio: 0.5 });
  vi.useRealTimers();
});

it('Ctrl+Shift+C 发送 showInFolder 当前文档路径', () => {
  const { shell, posted } = mount();
  load(shell, { path: 'C:\\notes\\a.md' });
  press('C', { ctrlKey: true, shiftKey: true });
  expect(lastPayload(posted, 'showInFolder')).toEqual({ path: 'C:\\notes\\a.md' });
});

it('输入框内不触发 F5/Alt+←→/Ctrl+Shift+C', () => {
  const { shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\b.md', 'b.md'), recentItem('C:\\a.md', 'a.md')] },
  });
  load(shell, { path: 'C:\\b.md' });
  const input = document.createElement('input');
  document.body.append(input);
  const dispatch = (key, modifiers) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));

  dispatch('F5', {});
  dispatch('ArrowLeft', { altKey: true });
  dispatch('C', { ctrlKey: true, shiftKey: true });

  expect(posted.filter((message) => ['reload', 'openFile', 'showInFolder'].includes(message.type))).toHaveLength(0);
});

// ── 工具条悬浮 ──

it('工具条默认隐藏：鼠标进入顶部 40px 或按 Alt 显示，离开 800ms 隐藏', () => {
  vi.useFakeTimers();
  const { root } = mount();
  expect(root.dataset.toolbar).toBe('hidden');
  expect(root.querySelector('#toolbar')).toBeTruthy();
  expect(root.querySelector('#progress-bar')).toBeTruthy();
  expect(root.querySelector('#back-to-top')).toBeTruthy();

  // 顶部 40px 内显示
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }));
  expect(root.dataset.toolbar).toBe('shown');

  // 鼠标离开工具条：800ms 后隐藏
  root.querySelector('#toolbar').dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(799);
  expect(root.dataset.toolbar).toBe('shown');
  vi.advanceTimersByTime(1);
  expect(root.dataset.toolbar).toBe('hidden');

  // 40px 之外不显示
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: 41 }));
  expect(root.dataset.toolbar).toBe('hidden');

  // Alt 显示，同样 800ms 后自动隐藏
  press('Alt');
  expect(root.dataset.toolbar).toBe('shown');
  vi.advanceTimersByTime(800);
  expect(root.dataset.toolbar).toBe('hidden');
  vi.useRealTimers();
});

it('工具条隐藏时键盘快捷键仍可用', () => {
  const { root } = mount();
  expect(root.dataset.toolbar).toBe('hidden');
  press('b', { ctrlKey: true });
  expect(root.dataset.toc).toBe('hidden');
});
