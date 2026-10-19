// Task 10：TOC 侧栏与滚动联动、主题三态、排版调节、快捷键（shell 阅读体验装配）。
// jsdom 没有真实布局/滚动：scrollTop / offsetTop / scrollTo 一律由用例显式桩注入（Object.defineProperty 或替换函数），
// 不依赖 jsdom 的布局实现；主题的 matchMedia 在 jsdom 中不存在，全部由用例桩提供。

const mounted = [];

/** 每个用例独立的 #app 容器（mountShell 的 root 就是 #app 本身）。 */
function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

/** 装配 shell，返回 { root, shell, posted }；destroy 在 afterEach 统一调用，避免 document 监听器泄漏到后续用例。 */
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
      markdown: '# 甲\n\n## 乙',
      settings: {},
      position: null,
      ...overrides,
    },
  });
}

function saveSettingsMessages(posted) {
  return posted.filter((message) => message.type === 'saveSettings');
}

/** 最后一条 saveSettings 的 patch；没有则 undefined。 */
function lastPatch(posted) {
  const messages = saveSettingsMessages(posted);
  return messages.length > 0 ? messages.at(-1).payload.patch : undefined;
}

/** 把元素 scrollTop 变成可读写变量（jsdom 默认恒为 0）。 */
function stubScrollTop(element, initial = 0) {
  let value = initial;
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

/** 按标签名桩 heading 的 offsetTop（渲染时 shell 从元素 offsetTop 采集）；返回恢复函数。 */
function stubHeadingTops(tops) {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetTop');
  Object.defineProperty(proto, 'offsetTop', {
    configurable: true,
    get() {
      return tops[this.tagName] ?? 0;
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(proto, 'offsetTop', original);
    } else {
      delete proto.offsetTop;
    }
  };
}

/** matchMedia 桩：matches 可改，dispatchChange 手动触发 change 监听。 */
function createMedia(dark) {
  const listeners = new Set();
  const mql = {
    matches: dark,
    addEventListener(type, listener) {
      if (type === 'change') {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === 'change') {
        listeners.delete(listener);
      }
    },
    dispatchChange(nextMatches) {
      if (typeof nextMatches === 'boolean') {
        mql.matches = nextMatches;
      }
      for (const listener of [...listeners]) {
        listener({ matches: mql.matches });
      }
    },
    listenerCount: () => listeners.size,
  };
  return mql;
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

/** 等一帧 rAF（scroll 事件经 rAF 节流后才调用 spy.update）。 */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
  delete window.matchMedia;
  delete window.ResizeObserver;
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  // 有的用例单独切到 fake timers：统一在这里恢复，避免定时器泄漏到后续文件/用例。
  vi.useRealTimers();
  delete window.matchMedia;
});

it('install 暴露任务 10 的全部 API（含 T4 carry-forward 的 applyCss）', () => {
  for (const name of ['buildToc', 'createScrollSpy', 'applyTheme', 'applySettings', 'settingsPatch', 'applyCss']) {
    expect(typeof JJ[name], name).toBe('function');
  }
  JJ.applyCss('.jj-test{color:red}');
  const style = document.head.querySelector('style[data-jj]');
  expect(style).toBeTruthy();
  expect(style.textContent).toBe('.jj-test{color:red}');
});

it('buildToc 生成 nav>ol>li[data-level]>a 结构', () => {
  const nav = JJ.buildToc([
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 300 },
  ]);
  expect(nav.tagName).toBe('NAV');
  expect(nav.className).toBe('toc');
  expect(nav.querySelectorAll('a')).toHaveLength(2);
  expect(nav.querySelectorAll('li')[1].dataset.level).toBe('2');
  expect(nav.querySelector('a').getAttribute('href')).toBe('#a');
  expect(nav.querySelector('ol')).toBeTruthy();
});

it('buildToc 无标题返回空 nav', () => {
  const empty = JJ.buildToc([]);
  expect(empty.tagName).toBe('NAV');
  expect(empty.querySelectorAll('a')).toHaveLength(0);
  expect(empty.querySelector('ol')).toBeNull();
  expect(JJ.buildToc(undefined).querySelectorAll('a')).toHaveLength(0);
});

it('buildToc 标题文本按文本写入，不注入 HTML', () => {
  const nav = JJ.buildToc([{ id: 'x', text: '<img src=x onerror=alert(1)>', level: 1 }]);
  expect(nav.querySelectorAll('img')).toHaveLength(0);
  expect(nav.querySelector('a').textContent).toBe('<img src=x onerror=alert(1)>');
});

it('buildToc 非法 level 兜底为 1', () => {
  const nav = JJ.buildToc([{ id: 'a', text: 'A', level: 99 }, { id: 'b', text: 'B', level: 0 }]);
  expect([...nav.querySelectorAll('li')].map((li) => li.dataset.level)).toEqual(['1', '1']);
});

it('applyTheme system 时解析为系统深色', () => {
  const media = createMedia(true);
  expect(JJ.applyTheme('system', { matchMedia: () => media })).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

it('applyTheme 固定主题时不跟随系统', () => {
  const media = createMedia(true);
  expect(JJ.applyTheme('light', { matchMedia: () => media })).toBe('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(JJ.applyTheme('dark', { matchMedia: () => media })).toBe('dark');
});

it('applyTheme system 的 change 事件更新 data-theme', () => {
  const media = createMedia(true);
  JJ.applyTheme('system', { matchMedia: () => media });
  expect(media.listenerCount()).toBe(1);
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

  media.dispatchChange(false);
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
});

it('applyTheme 未知主题值按 system 处理', () => {
  // jsdom 没有 matchMedia：system 解析为浅色
  expect(JJ.applyTheme('bogus')).toBe('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
});

it('applyTheme 切到固定主题后解除 system 的 change 订阅', () => {
  const media = createMedia(false);
  JJ.applyTheme('system', { matchMedia: () => media });
  expect(media.listenerCount()).toBe(1);

  JJ.applyTheme('dark', { matchMedia: () => media });
  expect(media.listenerCount()).toBe(0);
  media.dispatchChange(false);
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

it('applySettings 夹紧字号/行距并写 CSS 变量', () => {
  JJ.applySettings({ fontSize: 99, lineHeight: 1.0, contentWidth: 960 });
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--font-size')).toBe('24px');
  expect(style.getPropertyValue('--line-height')).toBe('1.4');
  expect(style.getPropertyValue('--content-width')).toBe('960px');
});

it('applySettings 低于下限同样夹紧', () => {
  JJ.applySettings({ fontSize: 1, lineHeight: 5 });
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--font-size')).toBe('14px');
  expect(style.getPropertyValue('--line-height')).toBe('2');
});

it('applySettings 行宽：0 表示全宽，其它值取最近档', () => {
  JJ.applySettings({ contentWidth: 0 });
  expect(document.documentElement.style.getPropertyValue('--content-width')).toBe('100%');
  JJ.applySettings({ contentWidth: 700 });
  expect(document.documentElement.style.getPropertyValue('--content-width')).toBe('640px');
  JJ.applySettings({ contentWidth: 1200 });
  expect(document.documentElement.style.getPropertyValue('--content-width')).toBe('960px');
});

it('applySettings 字体：system 用系统栈，自定义值作为前缀', () => {
  JJ.applySettings({ cjkFont: 'system' });
  const systemStack = document.documentElement.style.getPropertyValue('--font-cjk');
  expect(systemStack).toContain('Microsoft YaHei');

  JJ.applySettings({ cjkFont: 'Source Han Sans SC' });
  const custom = document.documentElement.style.getPropertyValue('--font-cjk');
  expect(custom.startsWith('Source Han Sans SC')).toBe(true);

  JJ.applySettings({ monoFont: 'Cascadia Mono' });
  expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('Cascadia Mono');
});

it('applySettings 缺省/非法值回落默认', () => {
  JJ.applySettings();
  JJ.applySettings({ fontSize: Number.NaN, lineHeight: 'abc', contentWidth: null });
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--font-size')).toBe('16px');
  expect(style.getPropertyValue('--line-height')).toBe('1.7');
  expect(style.getPropertyValue('--content-width')).toBe('780px');
});

it('设置变更只上报差异字段', () => {
  expect(JJ.settingsPatch({ fontSize: 16, theme: 'system' }, { fontSize: 18, theme: 'system' })).toEqual({
    fontSize: 18,
  });
});

it('settingsPatch 无变化返回空对象且对空值安全', () => {
  expect(JJ.settingsPatch({ fontSize: 16 }, { fontSize: 16 })).toEqual({});
  // 布尔 false 与 true 是真实变化（Object.is 比较，不做真值判断）
  expect(JJ.settingsPatch({ tocVisible: true }, { tocVisible: false })).toEqual({ tocVisible: false });
  expect(JJ.settingsPatch(null, null)).toEqual({});
  expect(JJ.settingsPatch({}, { theme: 'dark' })).toEqual({ theme: 'dark' });
  // 只比较 next 提供的字段：current 里多出来的字段不会出现在 patch 里
  expect(JJ.settingsPatch({ fontSize: 16, theme: 'dark' }, { fontSize: 16 })).toEqual({});
});

it('滚动联动高亮当前标题', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  const scroll = stubScrollTop(scroller, 0);

  spy.update();
  expect(active.at(-1)).toBe('a');
  scroll.set(500);
  spy.update();
  expect(active.at(-1)).toBe('b');
  spy.destroy();
});

it('滚动联动按 thresholdPx 命中「top ≤ scrollTop + threshold」的最后一个', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  const scroll = stubScrollTop(scroller, 0);

  scroll.set(319); // 319 + 80 = 399 < 400
  spy.update();
  expect(active.at(-1)).toBe('a');
  scroll.set(320); // 320 + 80 = 400 → 命中 B
  spy.update();
  expect(active.at(-1)).toBe('b');
  spy.destroy();
});

it('滚动联动索引不变时不重复回调', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  let calls = 0;
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: () => (calls += 1), thresholdPx: 80 });
  const scroll = stubScrollTop(scroller, 0);

  spy.update();
  spy.update();
  scroll.set(100);
  spy.update();
  expect(calls).toBe(1);
  spy.destroy();
});

it('滚动联动空标题列表不抛、不回调', () => {
  const scroller = document.createElement('div');
  let calls = 0;
  const spy = JJ.createScrollSpy({ scroller, headings: [], onActive: () => (calls += 1) });
  expect(() => spy.update()).not.toThrow();
  expect(calls).toBe(0);
  spy.destroy();
});

it('滚动联动在首个标题之前时高亮第一个', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 200 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  stubScrollTop(scroller, 0);
  spy.update();
  expect(active.at(-1)).toBe('a');
  spy.destroy();
});

it('scroll 事件经 rAF 节流后调用 update', async () => {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  const scroll = stubScrollTop(scroller, 0);

  scroll.set(500);
  scroller.dispatchEvent(new Event('scroll'));
  await nextFrame();
  expect(active.at(-1)).toBe('b');
  spy.destroy();
});

it('scrollSpy destroy 后不再响应滚动事件', async () => {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  const scroll = stubScrollTop(scroller, 0);
  spy.update();
  const before = active.length;

  spy.destroy();
  scroll.set(500);
  scroller.dispatchEvent(new Event('scroll'));
  await nextFrame();
  expect(active.length).toBe(before);
});

it('渲染后生成 TOC，并高亮第一个标题', () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400, H3: 800 });
  try {
    const { root, shell } = mount();
    load(shell, { markdown: '# 甲\n\n正文\n\n## 乙\n\n### 丙' });

    const links = [...root.querySelectorAll('#toc a')];
    expect(links.map((link) => link.textContent)).toEqual(['甲', '乙', '丙']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#甲', '#乙', '#丙']);
    expect(root.querySelectorAll('#toc li')[1].dataset.level).toBe('2');

    const active = root.querySelector('#toc a.active');
    expect(active).toBeTruthy();
    expect(active.textContent).toBe('甲');
    expect(active.getAttribute('aria-current')).toBe('true');
  } finally {
    restore();
  }
});

it('滚动后 TOC 高亮跟随当前标题', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400, H3: 800 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n正文\n\n## 乙\n\n### 丙' });

    scroll.set(420);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();

    const active = root.querySelector('#toc a.active');
    expect(active.textContent).toBe('乙');
    expect(root.querySelectorAll('#toc a.active')).toHaveLength(1);
  } finally {
    restore();
  }
});

it('标题 id 兜底：渲染后被 DOMPurify 剥掉的 title/body 重新赋回', () => {
  // 前提（T7 carry-forward）：清洗出口会剥掉与 DOM 同名的 id，因此壳层必须按 extractHeadings 顺序重赋
  expect(JJ.renderMarkdown('# title')).not.toContain('id="title"');

  const { root, shell } = mount();
  load(shell, { markdown: '# title\n\n正文\n\n## body' });

  const h1 = root.querySelector('#content h1');
  const h2 = root.querySelector('#content h2');
  expect(h1.id).toBe('title');
  expect(h2.id).toBe('body');
  expect(document.getElementById('title')).toBe(h1);
  expect(document.getElementById('body')).toBe(h2);

  const hrefs = [...root.querySelectorAll('#toc a')].map((link) => link.getAttribute('href'));
  expect(hrefs).toEqual(['#title', '#body']);
  for (const href of hrefs) {
    expect(document.getElementById(href.slice(1))).not.toBeNull();
  }
});

it('标题 id 兜底：重复标题仍唯一且可定位', () => {
  const { root, shell } = mount();
  load(shell, { markdown: '# title\n\n# title' });

  const ids = [...root.querySelectorAll('#content h1')].map((heading) => heading.id);
  expect(ids).toEqual(['title', 'title-2']);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(document.getElementById(id)).not.toBeNull();
  }
});

it('标题 id 兜底：空 slug 的纯标点标题也生成可用锚点', () => {
  const { root, shell } = mount();
  load(shell, { markdown: '# !!!\n\n# ???' });

  const ids = [...root.querySelectorAll('#content h1')].map((heading) => heading.id);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(document.getElementById(id)).not.toBeNull();
  }
  const hrefs = [...root.querySelectorAll('#toc a')].map((link) => link.getAttribute('href'));
  for (const href of hrefs) {
    expect(document.getElementById(href.slice(1))).not.toBeNull();
  }
});

it('原始 HTML 标题也纳入 TOC，且不打乱后续 markdown 标题 id', () => {
  const { root, shell } = mount();
  load(shell, { markdown: '# A\n\n<h2>原文标题</h2>\n\n## C' });

  const headings = [...root.querySelectorAll('#content h1, #content h2')];
  expect(headings.map((heading) => heading.textContent.trim())).toEqual(['A', '原文标题', 'C']);
  expect(headings.map((heading) => heading.id)).toEqual(['A', '原文标题', 'C']);
  expect([...root.querySelectorAll('#toc a')].map((link) => link.textContent)).toEqual(['A', '原文标题', 'C']);
});

it('TOC 点击 preventDefault 并按 top-80 平滑滚动', () => {
  const restore = stubHeadingTops({ H1: 500, H2: 900 });
  try {
    const { root, shell } = mount();
    load(shell, { markdown: '# 甲\n\n## 乙' });

    const content = root.querySelector('#content');
    const calls = [];
    content.scrollTo = (options) => calls.push(options);

    const links = root.querySelectorAll('#toc a');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[1].dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual([{ top: 820, behavior: 'smooth' }]);
  } finally {
    restore();
  }
});

it('主题按钮三态循环并持久化 patch', () => {
  const media = createMedia(true);
  window.matchMedia = () => media;

  const { root, shell, posted } = mount();
  load(shell);
  const html = document.documentElement;
  const button = root.querySelector('#theme-toggle');
  expect(button).toBeTruthy();
  expect(html.getAttribute('data-theme')).toBe('dark');
  expect(button.textContent).toContain('跟随系统');

  button.click();
  expect(html.getAttribute('data-theme')).toBe('light');
  expect(button.textContent).toContain('浅色');
  expect(lastPatch(posted)).toEqual({ theme: 'light' });
  expect(media.listenerCount()).toBe(0);

  button.click();
  expect(html.getAttribute('data-theme')).toBe('dark');
  expect(button.textContent).toContain('深色');
  expect(lastPatch(posted)).toEqual({ theme: 'dark' });

  button.click();
  expect(html.getAttribute('data-theme')).toBe('dark'); // system + 系统深色
  expect(button.textContent).toContain('跟随系统');
  expect(lastPatch(posted)).toEqual({ theme: 'system' });
});

it('load 下发设置后应用主题、侧栏与排版', () => {
  const { root, shell } = mount();
  load(shell, {
    settings: { theme: 'dark', fontSize: 20, lineHeight: 1.5, contentWidth: 640, tocVisible: false, palette: 'default' },
  });

  const style = document.documentElement.style;
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(document.documentElement.dataset.palette).toBe('default');
  expect(style.getPropertyValue('--font-size')).toBe('20px');
  expect(style.getPropertyValue('--line-height')).toBe('1.5');
  expect(style.getPropertyValue('--content-width')).toBe('640px');
  expect(root.dataset.toc).toBe('hidden');
  // Aa 面板控件同步为下发的设置
  expect(root.querySelector('[data-setting="fontSize"]').value).toBe('20');
  expect(root.querySelector('[data-setting="contentWidth"]').value).toBe('640');
  expect(root.querySelector('[data-setting="palette"]').value).toBe('default');
});

it('配色设置：默认中性（白底）、非法值回退 default，applySettings 写 data-palette', () => {
  const html = document.documentElement;
  JJ.applySettings({});
  expect(html.dataset.palette).toBe('default');

  JJ.applySettings({ palette: 'blue' });
  expect(html.dataset.palette).toBe('blue');

  JJ.applySettings({ palette: 'ocean' }); // 非法值 → default
  expect(html.dataset.palette).toBe('default');

  JJ.applySettings({ palette: 'blue', fontSize: 18 });
  expect(html.dataset.palette).toBe('blue');
  expect(html.style.getPropertyValue('--font-size')).toBe('18px');

  // palette 与 theme 正交：主题变化不重置配色，反之亦然
  JJ.applySettings({ palette: 'default' });
  JJ.applyTheme('dark');
  expect(html.getAttribute('data-theme')).toBe('dark');
  expect(html.dataset.palette).toBe('default');
  JJ.applySettings({ palette: 'blue' });
  expect(html.getAttribute('data-theme')).toBe('dark');
  expect(html.dataset.palette).toBe('blue');

  expect(JJ.settingsPatch({ palette: 'blue' }, { palette: 'default' })).toEqual({ palette: 'default' });
});

it('Aa 面板「配色」下拉：默认「默认」，切鲸鱼蓝即时生效并只落盘 {palette}', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  const select = panel.querySelector('[data-setting="palette"]');
  expect(select).toBeTruthy();
  expect(select.tagName).toBe('SELECT');
  expect([...select.options].map((option) => option.value)).toEqual(['default', 'blue']);
  expect([...select.options].map((option) => option.textContent)).toEqual(['默认', '鲸鱼蓝']);
  expect(select.value).toBe('default');
  expect(document.documentElement.dataset.palette).toBe('default');

  root.querySelector('#aa-toggle').click();
  const before = saveSettingsMessages(posted).length;
  select.value = 'blue';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.documentElement.dataset.palette).toBe('blue');
  expect(saveSettingsMessages(posted).length).toBe(before + 1);
  expect(lastPatch(posted)).toEqual({ palette: 'blue' });

  select.value = 'default';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.documentElement.dataset.palette).toBe('default');
  expect(lastPatch(posted)).toEqual({ palette: 'default' });
});

it('Ctrl+B 切换侧栏显隐并持久化 patch', () => {
  const { root, shell, posted } = mount();
  load(shell);
  expect(root.dataset.toc).toBe('visible');

  const first = press('b', { ctrlKey: true });
  expect(first.defaultPrevented).toBe(true);
  expect(root.dataset.toc).toBe('hidden');
  expect(lastPatch(posted)).toEqual({ tocVisible: false });

  press('b', { ctrlKey: true });
  expect(root.dataset.toc).toBe('visible');
  expect(lastPatch(posted)).toEqual({ tocVisible: true });
});

it('Ctrl+= / Ctrl+- 夹紧字号，Ctrl+0 重置', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--font-size')).toBe('16px');

  const event = press('=', { ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(style.getPropertyValue('--font-size')).toBe('17px');
  expect(lastPatch(posted)).toEqual({ fontSize: 17 });
  expect(root.querySelector('[data-setting="fontSize"]').value).toBe('17');

  for (let i = 0; i < 20; i += 1) {
    press('=', { ctrlKey: true });
  }
  expect(style.getPropertyValue('--font-size')).toBe('24px');
  expect(lastPatch(posted)).toEqual({ fontSize: 24 });

  press('-', { ctrlKey: true });
  expect(style.getPropertyValue('--font-size')).toBe('23px');
  expect(lastPatch(posted)).toEqual({ fontSize: 23 });

  press('0', { ctrlKey: true });
  expect(style.getPropertyValue('--font-size')).toBe('16px');
  expect(lastPatch(posted)).toEqual({ fontSize: 16 });
});

it('设置变更只发 patch（不是全量设置）', () => {
  const { shell, posted } = mount();
  load(shell);
  const before = saveSettingsMessages(posted).length;

  press('=', { ctrlKey: true });

  const messages = saveSettingsMessages(posted);
  expect(messages.length).toBe(before + 1);
  const payload = messages.at(-1).payload;
  expect(Object.keys(payload)).toEqual(['patch']);
  expect(payload.patch).toEqual({ fontSize: 17 });
  expect(payload).not.toHaveProperty('fontSize');
  expect(payload).not.toHaveProperty('settings');
  expect(payload).not.toHaveProperty('theme');
});

it('输入控件内的快捷键不触发', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const before = saveSettingsMessages(posted).length;

  const input = document.createElement('input');
  document.body.append(input);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));

  expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('16px');
  expect(root.dataset.toc).toBe('visible');
  expect(saveSettingsMessages(posted).length).toBe(before);
});

it('Ctrl+, 开/关 Aa 面板并同步 aria-expanded', () => {
  const { root, shell } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  const toggle = root.querySelector('#aa-toggle');
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  press(',', { ctrlKey: true });
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');

  press(',', { ctrlKey: true });
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('点击 Aa 面板外部关闭，点击面板内部不关闭', () => {
  const { root, shell } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  root.querySelector('#aa-toggle').click();
  expect(panel.hidden).toBe(false);

  // 点击面板内部（select）不关闭
  panel.querySelector('[data-setting="contentWidth"]').click();
  expect(panel.hidden).toBe(false);

  // 点击外部（body）关闭
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(panel.hidden).toBe(true);
  expect(root.querySelector('#aa-toggle').getAttribute('aria-expanded')).toBe('false');
});

it('Aa 面板控件变更即时应用，滑杆落盘防抖 300ms（T12 评审 Minor b）', () => {
  vi.useFakeTimers();
  const { root, shell, posted } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  root.querySelector('#aa-toggle').click();
  const style = document.documentElement.style;

  // 下拉选择仍是即时落盘
  const width = panel.querySelector('[data-setting="contentWidth"]');
  width.value = '960';
  width.dispatchEvent(new Event('change', { bubbles: true }));
  expect(style.getPropertyValue('--content-width')).toBe('960px');
  expect(lastPatch(posted)).toEqual({ contentWidth: 960 });

  // 滑杆：即时应用，300ms 无新输入才落盘
  const fontSize = panel.querySelector('[data-setting="fontSize"]');
  fontSize.value = '20';
  fontSize.dispatchEvent(new Event('input', { bubbles: true }));
  expect(style.getPropertyValue('--font-size')).toBe('20px');
  expect(lastPatch(posted)).toEqual({ contentWidth: 960 });
  vi.advanceTimersByTime(300);
  expect(lastPatch(posted)).toEqual({ fontSize: 20 });

  const lineHeight = panel.querySelector('[data-setting="lineHeight"]');
  lineHeight.value = '1.9';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  expect(style.getPropertyValue('--line-height')).toBe('1.9');
  vi.advanceTimersByTime(300);
  expect(lastPatch(posted)).toEqual({ lineHeight: 1.9 });

  const cjkFont = panel.querySelector('[data-setting="cjkFont"]');
  cjkFont.value = 'Source Han Sans SC';
  cjkFont.dispatchEvent(new Event('change', { bubbles: true }));
  expect(style.getPropertyValue('--font-cjk').startsWith('Source Han Sans SC')).toBe(true);
  expect(lastPatch(posted)).toEqual({ cjkFont: 'Source Han Sans SC' });

  const monoFont = panel.querySelector('[data-setting="monoFont"]');
  monoFont.value = 'Cascadia Mono';
  monoFont.dispatchEvent(new Event('change', { bubbles: true }));
  expect(style.getPropertyValue('--font-mono')).toContain('Cascadia Mono');
  expect(lastPatch(posted)).toEqual({ monoFont: 'Cascadia Mono' });
  vi.useRealTimers();
});

it('无标题文档显示「此文档没有标题」且 TOC 为空', () => {
  const { root, shell } = mount();
  load(shell, { markdown: '只有正文，没有标题。' });

  expect(root.querySelectorAll('#toc a')).toHaveLength(0);
  const empty = root.querySelector('#toc .toc-empty');
  expect(empty).toBeTruthy();
  expect(empty.textContent).toBe('此文档没有标题');
});

it('长 TOC（350 项）全量渲染是有意行为（>300 不虚拟滚动，已 descope）且耗时 < 500 ms', () => {
  // TOC>300 虚拟滚动已 descope（成本/收益不成立，见 spec §5.3 / progress.md）：350 项全量渲染
  // 是当前有意行为，用户实测滚动仍流畅。这里锁定「全量渲染 + 速度护栏」，防止有人误加虚拟滚动
  // 后改变既有 350 项 DOM 契约，也防止渲染退化成 O(n²)。
  const { root, shell, posted } = mount();
  const markdown = Array.from({ length: 350 }, (_, index) => `# 标题${index}`).join('\n\n');
  const started = performance.now();
  load(shell, { markdown });
  const elapsedMs = performance.now() - started;

  const links = root.querySelectorAll('#toc a');
  expect(links).toHaveLength(350);
  expect(links[349].getAttribute('href')).toBe('#标题349');
  const done = posted.find((message) => message.type === 'renderDone');
  expect(done.payload.tocCount).toBe(350);
  // 宽松上限（jsdom/慢机余量），不是性能预算门禁。
  expect(elapsedMs).toBeLessThan(500);
});

// ── TOC 侧栏拖拽调宽（Task 10 补漏：spec §5.1 要求默认 240 px、可拖 180–360 px） ──
// jsdom 没有 PointerEvent / 真实布局：用 new Event + Object.assign 注入 clientX，
// 起始宽直接取设置里的 tocWidth（load 下发的数字），不依赖 getBoundingClientRect。

/** 造一个带 clientX 的指针事件（jsdom 无 PointerEvent，事件对象上直接挂属性）。 */
function pointerEvent(type, clientX) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, pointerId: 1 });
  return event;
}

/** 取分隔条（不存在时直接失败，便于定位装配缺失）。 */
function resizerOf(root) {
  const resizer = root.querySelector('.toc-resizer');
  expect(resizer).toBeTruthy();
  return resizer;
}

it('TOC 分隔条：拖动实时改宽并同步 tocWidth 状态，拖拽中不落盘', () => {
  const { root, shell, posted } = mount();
  load(shell); // 默认 tocWidth 240
  const resizer = resizerOf(root);
  expect(resizer.getAttribute('role')).toBe('separator');
  expect(resizer.getAttribute('aria-orientation')).toBe('vertical');
  expect(resizer.getAttribute('aria-valuenow')).toBe('240');

  const down = pointerEvent('pointerdown', 300);
  resizer.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true); // 拖拽起点阻止默认行为（避免选中文本）

  resizer.dispatchEvent(pointerEvent('pointermove', 350)); // dx=+50 → 290
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--toc-width')).toBe('290px');
  expect(resizer.getAttribute('aria-valuenow')).toBe('290'); // 状态同步（aria 反映 state.settings.tocWidth）
  expect(saveSettingsMessages(posted)).toHaveLength(0); // 移动期间不落盘，松手才报一次

  resizer.dispatchEvent(pointerEvent('pointermove', 260)); // dx=-40 → 200
  expect(style.getPropertyValue('--toc-width')).toBe('200px');
  expect(saveSettingsMessages(posted)).toHaveLength(0);

  resizer.dispatchEvent(pointerEvent('pointerup', 260));
  expect(lastPatch(posted)).toEqual({ tocWidth: 200 });
});

it('TOC 分隔条：拖到越界（dx=-999 / +999）夹在 180 / 360', () => {
  const { root, shell, posted } = mount();
  load(shell, { settings: { tocWidth: 240 } });
  const resizer = resizerOf(root);
  const style = document.documentElement.style;

  resizer.dispatchEvent(pointerEvent('pointerdown', 500));
  resizer.dispatchEvent(pointerEvent('pointermove', 500 - 999)); // 240-999 → 夹到 180
  expect(style.getPropertyValue('--toc-width')).toBe('180px');
  expect(resizer.getAttribute('aria-valuenow')).toBe('180');

  resizer.dispatchEvent(pointerEvent('pointermove', 500 + 999)); // 240+999 → 夹到 360
  expect(style.getPropertyValue('--toc-width')).toBe('360px');
  expect(resizer.getAttribute('aria-valuenow')).toBe('360');

  resizer.dispatchEvent(pointerEvent('pointerup', 500 + 999));
  expect(lastPatch(posted)).toEqual({ tocWidth: 360 });
});

it('TOC 分隔条：pointerup 后 saveSettings 的 patch 只含 tocWidth', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const before = saveSettingsMessages(posted).length;
  const resizer = resizerOf(root);

  resizer.dispatchEvent(pointerEvent('pointerdown', 300));
  resizer.dispatchEvent(pointerEvent('pointermove', 280)); // 220
  resizer.dispatchEvent(pointerEvent('pointerup', 280));

  const messages = saveSettingsMessages(posted);
  expect(messages.length).toBe(before + 1);
  const payload = messages.at(-1).payload;
  expect(payload).toEqual({ patch: { tocWidth: 220 } });
  expect(payload).not.toHaveProperty('settings');
  expect(Object.keys(payload.patch)).toEqual(['tocWidth']);
});

it('TOC 分隔条：双击重置为 240 并持久化', () => {
  const { root, shell, posted } = mount();
  load(shell, { settings: { tocWidth: 320 } });
  const resizer = resizerOf(root);
  expect(document.documentElement.style.getPropertyValue('--toc-width')).toBe('320px');

  const dblclick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
  resizer.dispatchEvent(dblclick);

  expect(dblclick.defaultPrevented).toBe(true);
  expect(document.documentElement.style.getPropertyValue('--toc-width')).toBe('240px');
  expect(resizer.getAttribute('aria-valuenow')).toBe('240');
  expect(lastPatch(posted)).toEqual({ tocWidth: 240 });
});

it('侧栏折叠时分隔条不显示', () => {
  const { root, shell } = mount();
  load(shell, { settings: { tocVisible: false } });
  const resizer = resizerOf(root);
  expect(root.dataset.toc).toBe('hidden');
  expect(resizer.hidden).toBe(true); // 折叠时 hidden（CSS 另有 #app[data-toc='hidden'] 的 display:none 兜底）

  press('b', { ctrlKey: true });
  expect(root.dataset.toc).toBe('visible');
  expect(resizer.hidden).toBe(false);
});

it('applySettings 写入夹紧后的 --toc-width（180–360，默认 240）', () => {
  const style = document.documentElement.style;
  JJ.applySettings({ tocWidth: 999 });
  expect(style.getPropertyValue('--toc-width')).toBe('360px');
  JJ.applySettings({ tocWidth: 1 });
  expect(style.getPropertyValue('--toc-width')).toBe('180px');
  JJ.applySettings({});
  expect(style.getPropertyValue('--toc-width')).toBe('240px');
});

it('TOC 分隔条：方向键 ±10 调宽并持久化', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const resizer = resizerOf(root);
  const style = document.documentElement.style;

  const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  resizer.dispatchEvent(right);
  expect(right.defaultPrevented).toBe(true);
  expect(style.getPropertyValue('--toc-width')).toBe('250px');
  expect(lastPatch(posted)).toEqual({ tocWidth: 250 });

  resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  expect(style.getPropertyValue('--toc-width')).toBe('240px');
  expect(lastPatch(posted)).toEqual({ tocWidth: 240 });
});

// ── 标题位置刷新（评审修复：top 快照只采集一次，重排后会失效） ──
// 触发重排的真实场景：字号/行距/行宽变化（Aa 面板/快捷键）、TOC 侧栏拖宽、图片异步加载或占位替换、窗口尺寸变化。
// jsdom 没有真实布局/ResizeObserver：位置用 Object.defineProperty 覆盖 offsetTop 模拟，尺寸变化用可手动触发的桩。

/** 覆盖单个元素的 offsetTop（模拟重排后的实时位置）；返回可改写句柄。 */
function defineTop(element, initial) {
  let value = initial;
  Object.defineProperty(element, 'offsetTop', {
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

/** ResizeObserver 桩（jsdom 无该 API）：捕获 shell 注册的回调，可手动 trigger 模拟 #content 尺寸变化。 */
function stubResizeObserver() {
  const previous = window.ResizeObserver;
  const observers = [];
  class StubResizeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target) {
      this.target = target;
    }

    disconnect() {
      this.target = null;
    }

    trigger() {
      this.callback([{ target: this.target }], this);
    }
  }
  window.ResizeObserver = StubResizeObserver;
  return {
    observers,
    restore: () => {
      if (previous) {
        window.ResizeObserver = previous;
      } else {
        delete window.ResizeObserver;
      }
    },
  };
}

it('字号变化（applySettings 路径）后刷新标题 top，高亮与点击都用新位置', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n正文\n\n## 乙' });
    await nextFrame(); // 等 load 后的首帧校准落定，再模拟重排
    const h2 = root.querySelector('#content h2');
    defineTop(h2, 1200); // 字号 16→17 后标题下移（相对 #content 的真实位置）

    scroll.set(900);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('乙'); // 旧快照 top=400：900+80 已越过

    press('=', { ctrlKey: true }); // applySettings 路径 → 刷新（rAF 合并）
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲'); // 新 top=1200：900+80 还没到乙

    const calls = [];
    content.scrollTo = (options) => calls.push(options);
    root.querySelectorAll('#toc a')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(calls).toEqual([{ top: 1120, behavior: 'smooth' }]); // 1200 - 80，而不是快照 400 - 80
  } finally {
    restore();
  }
});

it('#content 尺寸变化（ResizeObserver）触发标题位置刷新', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  const observer = stubResizeObserver();
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n## 乙' });
    expect(observer.observers).toHaveLength(1);
    expect(observer.observers[0].target).toBe(content); // 观察正文滚动列

    defineTop(root.querySelector('#content h2'), 1200); // 侧栏拖宽/窗口尺寸变化导致的重排
    observer.observers[0].trigger();
    await nextFrame();

    scroll.set(900);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲');
  } finally {
    observer.restore();
    restore();
  }
});

it('TOC 侧栏拖拽预览/松手后也刷新标题位置', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n## 乙' });
    defineTop(root.querySelector('#content h2'), 1200); // 拖宽后重排

    const resizer = resizerOf(root);
    resizer.dispatchEvent(pointerEvent('pointerdown', 300));
    resizer.dispatchEvent(pointerEvent('pointermove', 350)); // 拖拽预览
    resizer.dispatchEvent(pointerEvent('pointerup', 350)); // 松手 commit
    await nextFrame();

    scroll.set(900);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲');
  } finally {
    restore();
  }
});

it('TOC 点击实时读取元素位置，快照过期也不跳错', () => {
  const restore = stubHeadingTops({ H1: 500, H2: 900 });
  try {
    const { root, shell } = mount();
    load(shell, { markdown: '# 甲\n\n## 乙' });
    const content = root.querySelector('#content');
    const calls = [];
    content.scrollTo = (options) => calls.push(options);

    defineTop(root.querySelector('#content h2'), 1400); // 快照仍为 900，且不触发任何刷新
    root.querySelectorAll('#toc a')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(calls).toEqual([{ top: 1320, behavior: 'smooth' }]); // 实时 1400 - 80
  } finally {
    restore();
  }
});

it('scroll spy 不假定 top 单调：乱序标题线性扫描取最大命中 top', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 800 },
    { id: 'c', text: 'C', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  stubScrollTop(scroller, 500); // 500+80=580：命中 a(0) 与 c(400)，最大 top 是 c

  expect(() => spy.update()).not.toThrow();
  expect(active.at(-1)).toBe('c');
  expect(active.every((id) => typeof id === 'string' && id !== '')).toBe(true);
  spy.destroy();
});

it('折叠 details 内标题（hidden 标记）不抢滚动高亮', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 0, hidden: true }, // 折叠 details 内：offsetTop=0
    { id: 'c', text: 'C', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  stubScrollTop(scroller, 0);
  spy.update();
  expect(active.at(-1)).toBe('a'); // a 与 b 的 top 相同，隐藏的 b 不能后来居上
  spy.destroy();
});

it('scroll spy setHeadings 替换标题表后立即重算高亮', () => {
  const scroller = document.createElement('div');
  const headings = [
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 400 },
  ];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (heading) => active.push(heading.id), thresholdPx: 80 });
  stubScrollTop(scroller, 500); // 500+80=580 → 旧 top 400 命中 b
  spy.update();
  expect(active.at(-1)).toBe('b');
  expect(typeof spy.setHeadings).toBe('function');

  spy.setHeadings([
    { id: 'a', text: 'A', level: 1, top: 0 },
    { id: 'b', text: 'B', level: 2, top: 900 }, // 重排后的新位置
  ]);
  spy.update();
  expect(active.at(-1)).toBe('a');
  spy.destroy();
});

it('折叠 details 内的标题在刷新后不抢高亮（shell 采集 hidden）', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n## 乙' });

    scroll.set(500);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('乙');

    // 把乙包进闭合 <details>：真实浏览器里它的 offsetTop / offsetHeight 都会归 0
    const h2 = root.querySelector('#content h2');
    const details = document.createElement('details');
    h2.replaceWith(details);
    details.append(h2);
    defineTop(h2, 0);

    press('=', { ctrlKey: true }); // 设置变化触发刷新
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲'); // 隐藏标题按跳过处理
    expect(root.querySelectorAll('#toc a.active')).toHaveLength(1);
  } finally {
    restore();
  }
});

it('图片加载失败换占位后刷新标题位置，高亮跟随', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n![图](a.png)\n\n## 乙' });
    const img = root.querySelector('#content img');
    expect(img).toBeTruthy();
    defineTop(root.querySelector('#content h2'), 1200); // 占位替换后标题下移

    img.dispatchEvent(new Event('error')); // capture 阶段监听 → 刷新（rAF 合并）
    await nextFrame();
    expect(root.querySelector('#content .img-placeholder')).toBeTruthy(); // enhance 已换占位

    scroll.set(900);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲');
  } finally {
    restore();
  }
});

it('details 展开/折叠（toggle 不冒泡）后也刷新标题位置', async () => {
  const restore = stubHeadingTops({ H1: 0, H2: 400 });
  try {
    const { root, shell } = mount();
    const content = root.querySelector('#content');
    const scroll = stubScrollTop(content, 0);
    load(shell, { markdown: '# 甲\n\n## 乙' });

    scroll.set(900);
    content.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('乙');

    // 在乙前插入一个 details：展开后正文整体下移（jsdom 无布局，用 offsetTop 桩模拟）
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '折叠块';
    details.append(summary);
    const h2 = root.querySelector('#content h2');
    h2.before(details);
    defineTop(h2, 1200);

    // details 的 toggle 不冒泡：#content 必须在捕获阶段收到并刷新标题 top 快照
    details.dispatchEvent(new Event('toggle'));
    await nextFrame();
    expect(root.querySelector('#toc a.active').textContent).toBe('甲');
  } finally {
    restore();
  }
});
