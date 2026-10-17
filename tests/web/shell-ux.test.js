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

/** IntersectionObserver 桩：分块渲染保留哨兵（jsdom 缺该 API 时 chunk.js 会兜底 renderAll）。 */
function installObserverStub() {
  const previous = globalThis.IntersectionObserver;
  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}

    unobserve() {}

    disconnect() {}
  }
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  return {
    restore() {
      if (previous === undefined) {
        delete globalThis.IntersectionObserver;
      } else {
        globalThis.IntersectionObserver = previous;
      }
    },
  };
}

/** 分块文档的滚动容器桩：有哨兵（只渲染首屏）时矮，renderAll 移除哨兵后撑满。 */
function stubChunkedHeight(content, { initialHeight = 1000, fullHeight = 5000, clientHeight = 1000 } = {}) {
  let value = 0;
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get: () => (content.querySelector('.chunk-sentinel') ? initialHeight : fullHeight),
  });
  Object.defineProperty(content, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(content, 'scrollTop', {
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

/** 多块小文档（降阈值后足以触发分块渲染）。 */
function chunkedMarkdown() {
  return [
    '# 甲',
    '',
    '第一段',
    '',
    '## 乙',
    '',
    '第二段',
    '',
    '## 丙',
    '',
    '第三段',
    '',
    '## 丁',
    '',
    '第四段',
    '',
  ].join('\n');
}

/** 包一层 createChunkedRenderer，统计 renderAll 调用次数（恢复位置用）。 */
function spyRenderAll() {
  const original = JJ.createChunkedRenderer;
  const state = { calls: 0 };
  JJ.createChunkedRenderer = (options) => {
    const renderer = original(options);
    const originalRenderAll = renderer.renderAll;
    renderer.renderAll = (...args) => {
      state.calls += 1;
      return originalRenderAll(...args);
    };
    return renderer;
  };
  return {
    state,
    restore() {
      JJ.createChunkedRenderer = original;
    },
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
  // Enter 必须在真实焦点项上触发（浏览器里 keydown 的 target 就是被聚焦的按钮）：
  // 面板只在 target 属于 [data-path] 时拦截 Enter，避免误吃「打开文件…」按钮的默认激活。
  buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(opened).toEqual(['C:\\b.md']);

  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  buttons[0].click();
  expect(opened.at(-1)).toBe('C:\\a.md');

  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(closed).toHaveLength(1);
});

it('最近文件键盘事件直接派发在面板上（不冒泡）也能处理，Enter 只认焦点项', () => {
  // 计划里的原始用例写法：new KeyboardEvent('keydown', { key }) 直接派发到容器
  const opened = [];
  const el = JJ.renderRecent([recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')], {
    onOpen: (path) => opened.push(path),
  });
  document.body.append(el); // focus() 只有在文档内才会更新 activeElement
  expect(el.querySelectorAll('[data-path]')).toHaveLength(2);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  expect(document.activeElement).toBe(el.querySelector('[data-path]'));
  // Enter 走真实焦点项（bubbles:true 才能从按钮冒泡到面板监听）
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(opened).toEqual(['C:\\a.md']);
});

it('「打开文件…」按钮上的 Enter 不被面板拦截，最近项上的 Enter 才打开', () => {
  const opened = [];
  const picked = [];
  const el = JJ.renderRecent([recentItem('C:\\a.md', 'a.md')], {
    onOpen: (path) => opened.push(path),
    onPickFile: () => picked.push(1),
  });
  document.body.append(el);
  const pick = el.querySelector('.recent-open');
  pick.focus();

  const onButton = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  pick.dispatchEvent(onButton);
  // 未 preventDefault：浏览器随后把 Enter 转成按钮 click（这里是放行默认行为的判据）
  expect(onButton.defaultPrevented).toBe(false);
  expect(opened).toEqual([]);
  expect(picked).toEqual([]);
  // 模拟浏览器默认激活：点击按钮 → 交给 onPickFile（不是打开最近第一条）
  pick.click();
  expect(picked).toEqual([1]);
  expect(opened).toEqual([]);

  const item = el.querySelector('[data-path]');
  item.focus();
  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(opened).toEqual(['C:\\a.md']);
});

it('无最近项时面板不拦截 Enter（「打开文件…」按钮仍可正常激活）', () => {
  const picked = [];
  const el = JJ.renderRecent([], { onPickFile: () => picked.push(1) });
  document.body.append(el);
  const pick = el.querySelector('.recent-open');
  pick.focus();
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  pick.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  pick.click();
  expect(picked).toEqual([1]);
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

// ── 分块文档位置比例估算（T12 评审 Important 1） ──

it('位置比例：分块未全部渲染时按估算全文高度计算，全部渲染后回到真实高度', () => {
  const sent = [];
  const scroller = document.createElement('div');
  const scroll = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 500 });
  let chunkBytes = { renderedBytes: 256 * 1024, totalBytes: 1024 * 1024 };
  const tracker = JJ.createPositionTracker({
    scroller,
    key: 'k',
    emit: (key, ratio) => sent.push([key, ratio]),
    readChunkBytes: () => chunkBytes,
    estimateTotalHeight: JJ.estimateTotalHeight,
  });
  tracker.start();
  scroll.set(500);
  tracker.flush();
  // 首屏只渲染了 1/4 字节：estimatedTotal = 1000 + (1000 / 256K) × 768K = 4000 → 500 / (4000 - 500)。
  // 旧口径（首屏高度做分母）会得到 500 / (1000 - 500) = 1，完全失真。
  expect(sent).toEqual([['k', 500 / 3500]]);

  // 全部渲染完（readChunkBytes 返回 null）→ 用真实 scrollHeight 做分母
  chunkBytes = null;
  tracker.flush();
  expect(sent.at(-1)).toEqual(['k', 1]);
  tracker.destroy();
});

it('estimateTotalHeight 按字节密度外推未渲染部分，边界夹紧', () => {
  expect(JJ.estimateTotalHeight(1000, 256 * 1024, 1024 * 1024)).toBe(4000);
  expect(JJ.estimateTotalHeight(1000, 1024, 1024)).toBe(1000); // 全部渲染：不外推
  expect(JJ.estimateTotalHeight(1000, 0, 1024)).toBe(1000); // 无已渲染字节基准
  expect(JJ.estimateTotalHeight(1000, 2048, 1024)).toBe(1000); // 已渲染字节超过总数：夹紧
  expect(JJ.estimateTotalHeight(Number.NaN, 1, 2)).toBe(0); // 非法高度
});

// ── 进度条 / 回到顶部 ──

it('updateChrome 写竖向进度条高度百分比（spec §5.1），并按 400px 阈值显隐回到顶部', () => {
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
  // 右侧 3px 竖向条：填充元素按 height 比例增长，不再写横向 width
  expect(parseFloat(progressEl.style.height)).toBeCloseTo((100 / 2200) * 100, 2);
  expect(progressEl.style.height.endsWith('%')).toBe(true);
  expect(progressEl.style.width).toBe('');

  scroll.set(900);
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  expect(backToTopEl.hidden).toBe(false);
  expect(parseFloat(progressEl.style.height)).toBeCloseTo((900 / 2200) * 100, 2);

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
  expect(parseFloat(progressEl.style.height)).toBe(0);
  expect(backToTopEl.hidden).toBe(true);

  // 不可滚动容器的分母兜底为 1：scrollTop > 0 时比例夹紧到 1
  scroll.set(1);
  JJ.updateChrome({ scroller, progressEl, backToTopEl, thresholdPx: 0 });
  expect(parseFloat(progressEl.style.height)).toBe(100);
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

it('空白页最近文件项点击/Enter 发送 openRecent 绝对路径，Esc 关闭面板', () => {
  const { root, shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')] },
  });
  const panel = root.querySelector('#content .recent-panel');
  panel.querySelectorAll('[data-path]')[1].click();
  expect(lastPayload(posted, 'openRecent')).toEqual({ path: 'C:\\b.md' });

  press('Escape');
  expect(root.querySelector('#content .recent-panel')).toBeNull();
});

// ── 工具条「最近」菜单（spec §5.6：与空白启动页共用最近列表） ──

it('工具条「最近」按钮弹出最近文件菜单，选中项发送 openRecent', () => {
  const { root, shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')] },
  });
  const toggle = root.querySelector('#toolbar #recent-toggle');
  const menu = root.querySelector('#recent-menu');
  expect(toggle).toBeTruthy();
  expect(menu.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  toggle.click();
  expect(menu.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  // 与空白启动页同一份 state.recent：菜单里就是最近消息的两项
  const items = menu.querySelectorAll('.recent-panel [data-path]');
  expect(items).toHaveLength(2);
  expect([...items].map((item) => item.dataset.path)).toEqual(['C:\\a.md', 'C:\\b.md']);

  items[1].click();
  expect(lastPayload(posted, 'openRecent')).toEqual({ path: 'C:\\b.md' });
  expect(menu.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('工具条最近菜单：点击外部与 Esc 关闭，打开期间 recent 刷新同一份列表', () => {
  const { root, shell } = mount();
  const toggle = root.querySelector('#recent-toggle');
  const menu = root.querySelector('#recent-menu');
  shell.onMessage({ type: 'recent', payload: { items: [recentItem('C:\\a.md', 'a.md')] } });

  toggle.click();
  expect(menu.hidden).toBe(false);
  // 打开期间收到新列表：菜单同步渲染（共用 state.recent，无需重新打开）
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\b.md', 'b.md'), recentItem('C:\\a.md', 'a.md')] },
  });
  expect(menu.querySelectorAll('.recent-panel [data-path]')).toHaveLength(2);

  document.body.click(); // 点击菜单/按钮之外
  expect(menu.hidden).toBe(true);

  toggle.click();
  expect(menu.hidden).toBe(false);
  press('Escape');
  expect(menu.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  // 打开文档后空白页面板消失，但工具条菜单仍读同一份 state.recent（空白页与菜单共用的口径）
  load(shell, { path: 'C:\\b.md' });
  expect(root.querySelector('#content .recent-panel')).toBeNull();
  toggle.click();
  expect(menu.hidden).toBe(false);
  expect(menu.querySelectorAll('.recent-panel [data-path]')).toHaveLength(2);
});

it('工具条最近菜单打开后焦点在第一项，↑↓/Enter 立即可用（Minor a）', () => {
  const { root, shell, posted } = mount();
  shell.onMessage({
    type: 'recent',
    payload: { items: [recentItem('C:\\a.md', 'a.md'), recentItem('C:\\b.md', 'b.md')] },
  });
  const toggle = root.querySelector('#recent-toggle');
  const menu = root.querySelector('#recent-menu');

  toggle.click();
  const items = [...menu.querySelectorAll('.recent-panel [data-path]')];
  expect(document.activeElement).toBe(items[0]);
  expect(items[0].tabIndex).toBe(0); // 仍是原生 button：Tab 可达

  // 焦点已在第一项时 ↓ 继续下移（不能停在第一项）→ Enter 打开第二项
  items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(items[1]);
  items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(lastPayload(posted, 'openRecent')).toEqual({ path: 'C:\\b.md' });
  expect(menu.hidden).toBe(true);
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
  expect(parseFloat(root.querySelector('#progress-bar').style.height)).toBeCloseTo(50, 2);

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

it('position=0 时不弹「已回到上次位置」（Minor c）', () => {
  const { root, shell } = mount();
  stubScroll(root.querySelector('#content'), { scrollHeight: 2000, clientHeight: 1000 });
  load(shell, { position: 0 });
  expect(root.querySelector('#toast .toast')).toBeNull();
});

it('内容不可滚动（scrollHeight ≤ clientHeight）时不弹位置提示（Minor c）', () => {
  const { root, shell } = mount();
  stubScroll(root.querySelector('#content'), { scrollHeight: 1000, clientHeight: 1000 });
  load(shell, { position: 0.5 });
  expect(root.querySelector('#toast .toast')).toBeNull();
});

it('分块文档恢复位置：先 renderAll 再按渲染后的实时 scrollHeight 计算 scrollTop', () => {
  const observer = installObserverStub();
  const originalThreshold = JJ.CHUNK_THRESHOLD;
  const originalInitial = JJ.INITIAL_BYTES;
  const renderAllSpy = spyRenderAll();
  JJ.CHUNK_THRESHOLD = 1; // 任意非空文档走分块
  JJ.INITIAL_BYTES = 1; // 首屏只渲染第一块，其余留哨兵
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubChunkedHeight(content, { initialHeight: 1000, fullHeight: 5000 });
    load(shell, { markdown: chunkedMarkdown(), position: 0.8 });

    expect(renderAllSpy.state.calls).toBe(1);
    expect(content.querySelector('.chunk-sentinel')).toBeNull();
    expect(content.textContent).toContain('第四段');
    // 旧实现按首屏 scrollHeight 恢复（0.8 × (1000-1000) = 0）；新实现按 renderAll 后的 5000 计算
    expect(scroll.get()).toBeCloseTo(0.8 * (5000 - 1000), 5);
    // Minor d：同步 renderAll 前的「正在恢复…」toast 无法绘制，已去掉；只剩最终提示一条
    const toasts = [...root.querySelectorAll('#toast .toast')];
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).not.toContain('正在恢复');
    expect(toasts[0].textContent).toContain('已回到上次位置 · 回到顶部');
  } finally {
    renderAllSpy.restore();
    JJ.CHUNK_THRESHOLD = originalThreshold;
    JJ.INITIAL_BYTES = originalInitial;
    observer.restore();
  }
});

it('huge 模式分块文档同样先 renderAll 再恢复位置', () => {
  const observer = installObserverStub();
  const originalIsHuge = JJ.isHuge;
  const originalInitial = JJ.INITIAL_BYTES;
  const renderAllSpy = spyRenderAll();
  JJ.isHuge = () => true;
  JJ.INITIAL_BYTES = 1;
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubChunkedHeight(content, { initialHeight: 1000, fullHeight: 5000 });
    load(shell, { markdown: chunkedMarkdown(), position: 0.5 });

    expect(renderAllSpy.state.calls).toBe(1);
    expect(content.querySelector('.chunk-sentinel')).toBeNull();
    expect(scroll.get()).toBeCloseTo(0.5 * (5000 - 1000), 5);
  } finally {
    renderAllSpy.restore();
    JJ.isHuge = originalIsHuge;
    JJ.INITIAL_BYTES = originalInitial;
    observer.restore();
  }
});

it('分块文档上报的位置比例按估算全文高度，renderAll 后用真实高度（Important 1）', () => {
  const observer = installObserverStub();
  const originalThreshold = JJ.CHUNK_THRESHOLD;
  const originalInitial = JJ.INITIAL_BYTES;
  const originalSplit = JJ.splitBlocks;
  // 4 块等长（每块 247 UTF-8 字节，总 988 字节）：首屏只渲染第一块 → 已渲染字节 = 1/4 全文
  const block = `## b\n\n${'x'.repeat(240)}\n`;
  const blocks = [block, block, block, block];
  const markdown = blocks.join('');
  JJ.CHUNK_THRESHOLD = 1;
  JJ.INITIAL_BYTES = 1;
  JJ.splitBlocks = () => ({ blocks, totalBytes: 988 });
  vi.useFakeTimers();
  try {
    const { root, shell, posted } = mount();
    const content = root.querySelector('#content');
    const scroll = stubChunkedHeight(content, { initialHeight: 1000, fullHeight: 5000, clientHeight: 500 });
    load(shell, { key: 'key-a', markdown, position: null });
    expect(content.querySelector('.chunk-sentinel')).toBeTruthy();

    scroll.set(250); // 首屏可滚动区（1000-500）的一半
    content.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(500);
    // 旧口径 250/(1000-500)=0.5；估算 250/(4000-500)
    const saved = lastPayload(posted, 'savePosition');
    expect(saved.key).toBe('key-a');
    expect(saved.ratio).toBeCloseTo(250 / 3500, 12);
    expect(saved.ratio).not.toBeCloseTo(0.5, 2);

    // 全部渲染（load 带 position → renderAll）后不再估算：按真实 scrollHeight=5000 计算
    load(shell, { key: 'key-b', markdown, position: 0.8 });
    expect(content.querySelector('.chunk-sentinel')).toBeNull();
    expect(scroll.get()).toBeCloseTo(0.8 * (5000 - 500), 5);
    content.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(500);
    const afterFull = lastPayload(posted, 'savePosition');
    expect(afterFull.key).toBe('key-b');
    expect(afterFull.ratio).toBeCloseTo(0.8, 12);
  } finally {
    vi.useRealTimers();
    JJ.splitBlocks = originalSplit;
    JJ.CHUNK_THRESHOLD = originalThreshold;
    JJ.INITIAL_BYTES = originalInitial;
    observer.restore();
  }
});

it('切换文档前 flush 旧位置追踪器，旧 key 的最后位置不丢（Important 2）', () => {
  const { root, shell, posted } = mount();
  const content = root.querySelector('#content');
  const scroll = stubScroll(content, { scrollHeight: 3000, clientHeight: 1000 });
  load(shell, { path: 'a.md', key: 'key-a', position: null });

  scroll.set(500); // 落在 500ms 节流窗口内，尚未落盘
  content.dispatchEvent(new Event('scroll'));
  expect(posted.filter((message) => message.type === 'savePosition')).toHaveLength(0);

  load(shell, { path: 'b.md', key: 'key-b', position: null });
  const saved = posted.filter((message) => message.type === 'savePosition');
  expect(saved).toHaveLength(1);
  expect(saved[0].payload).toEqual({ key: 'key-a', ratio: 0.25 }); // 旧 key + 旧文档的位置
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
  expect(parseFloat(root.querySelector('#progress-bar').style.height)).toBeCloseTo((900 / 2200) * 100, 2);
  // aria-valuenow 同步（T12 原报告 §10.6 carry-forward）
  expect(root.querySelector('#progress').getAttribute('aria-valuenow')).toBe(
    String(Math.round((900 / 2200) * 100)),
  );
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
  expect(lastPayload(posted, 'openRecent')).toEqual({ path: 'C:\\a.md' });

  load(shell, { path: 'C:\\a.md' }); // 第 1 项
  press('ArrowRight', { altKey: true }); // 下一份（更新）= 第 0 项
  expect(lastPayload(posted, 'openRecent')).toEqual({ path: 'C:\\b.md' });

  load(shell, { path: 'C:\\b.md' }); // 已在最新：再「下一份」无动作
  const before = posted.filter((message) => message.type === 'openRecent').length;
  press('ArrowRight', { altKey: true });
  expect(posted.filter((message) => message.type === 'openRecent')).toHaveLength(before);
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

  expect(posted.filter((message) => ['reload', 'openRecent', 'showInFolder'].includes(message.type))).toHaveLength(0);
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

it('工具条 800ms 自动隐藏时最近菜单开着：先不隐藏，菜单关闭后再隐藏（Minor f）', () => {
  vi.useFakeTimers();
  const { root, shell } = mount();
  shell.onMessage({ type: 'recent', payload: { items: [recentItem('C:\\a.md', 'a.md')] } });
  const toggle = root.querySelector('#recent-toggle');
  const menu = root.querySelector('#recent-menu');

  document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }));
  expect(root.dataset.toolbar).toBe('shown');
  toggle.click();
  expect(menu.hidden).toBe(false);

  root.querySelector('#toolbar').dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(800);
  expect(root.dataset.toolbar).toBe('shown'); // 菜单开着：不隐藏工具条

  document.body.click(); // 点击外部关闭菜单
  expect(menu.hidden).toBe(true);
  expect(root.dataset.toolbar).toBe('hidden'); // 菜单关闭后按规则隐藏
  vi.useRealTimers();
});

it('Esc 在可编辑控件内不隐藏工具条（Minor g）', () => {
  const { root, shell } = mount();
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }));
  expect(root.dataset.toolbar).toBe('shown');

  const input = document.createElement('input');
  document.body.append(input);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(root.dataset.toolbar).toBe('shown');

  // 非可编辑区域（document.body）上的 Esc 仍按原规则隐藏工具条
  press('Escape');
  expect(root.dataset.toolbar).toBe('hidden');
});

// ── Aa 面板：落盘防抖与滑杆无障碍（Minor b / e） ──

it('Aa 面板滑杆落盘防抖 300ms：连续拖动只发一次 patch，关闭面板立即 flush（Minor b）', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  load(shell);
  root.querySelector('#aa-toggle').click();
  const panel = root.querySelector('#aa-panel');
  const slider = panel.querySelector('[data-setting="fontSize"]');

  for (const value of ['17', '18', '19']) {
    slider.value = value;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 即时应用，但落盘合并成一条（300ms 防抖）
  expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('19px');
  vi.advanceTimersByTime(299);
  expect(posted.filter((message) => message.type === 'saveSettings')).toHaveLength(0);
  vi.advanceTimersByTime(1);
  const messages = posted.filter((message) => message.type === 'saveSettings');
  expect(messages).toHaveLength(1);
  expect(messages[0].payload.patch).toEqual({ fontSize: 19 });

  // 关闭面板（点击外部）：pending 的 patch 立即落盘，不等防抖
  slider.value = '20';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(panel.hidden).toBe(true);
  const flushed = posted.filter((message) => message.type === 'saveSettings');
  expect(flushed).toHaveLength(2);
  expect(flushed.at(-1).payload.patch).toEqual({ fontSize: 20 });
  vi.useRealTimers();
});

it('pagehide / 页面隐藏时立即 flush 防抖中的设置 patch（与位置追踪同口径）', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  load(shell);
  root.querySelector('#aa-toggle').click();
  const slider = root.querySelector('#aa-panel [data-setting="fontSize"]');
  const savePatches = () =>
    posted.filter((message) => message.type === 'saveSettings').map((message) => message.payload.patch);

  // pagehide：关窗前把 pending 的滑杆 patch 落盘（不等 300ms）
  slider.value = '21';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  expect(savePatches()).toEqual([]);
  window.dispatchEvent(new Event('pagehide'));
  expect(savePatches()).toEqual([{ fontSize: 21 }]);

  // visibilitychange(hidden)：切到后台同样要落盘
  slider.value = '22';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  const restoreHidden = stubVisibility('hidden');
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    restoreHidden();
  }
  expect(savePatches().at(-1)).toEqual({ fontSize: 22 });

  // visible：不 flush（避免无意义落盘）
  slider.value = '23';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  const restoreVisible = stubVisibility('visible');
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    restoreVisible();
  }
  expect(savePatches()).toHaveLength(2);
  vi.useRealTimers();
});

it('Aa 滑杆 aria-valuenow 随数值更新（Minor e）', () => {
  const { root, shell } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  const fontSize = panel.querySelector('[data-setting="fontSize"]');
  expect(fontSize.getAttribute('aria-valuemin')).toBe('14');
  expect(fontSize.getAttribute('aria-valuemax')).toBe('24');
  expect(fontSize.getAttribute('aria-valuenow')).toBe('16');

  // 快捷键改字号：面板回显与 aria-valuenow 一起同步
  press('=', { ctrlKey: true });
  expect(fontSize.value).toBe('17');
  expect(fontSize.getAttribute('aria-valuenow')).toBe('17');

  fontSize.value = '20';
  fontSize.dispatchEvent(new Event('input', { bubbles: true }));
  expect(fontSize.getAttribute('aria-valuenow')).toBe('20');
});
