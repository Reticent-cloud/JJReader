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
  delete window.matchMedia;
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
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
    settings: { theme: 'dark', fontSize: 20, lineHeight: 1.5, contentWidth: 640, tocVisible: false },
  });

  const style = document.documentElement.style;
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(style.getPropertyValue('--font-size')).toBe('20px');
  expect(style.getPropertyValue('--line-height')).toBe('1.5');
  expect(style.getPropertyValue('--content-width')).toBe('640px');
  expect(root.dataset.toc).toBe('hidden');
  // Aa 面板控件同步为下发的设置
  expect(root.querySelector('[data-setting="fontSize"]').value).toBe('20');
  expect(root.querySelector('[data-setting="contentWidth"]').value).toBe('640');
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

it('Aa 面板控件变更即时应用并持久化', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  root.querySelector('#aa-toggle').click();
  const style = document.documentElement.style;

  const width = panel.querySelector('[data-setting="contentWidth"]');
  width.value = '960';
  width.dispatchEvent(new Event('change', { bubbles: true }));
  expect(style.getPropertyValue('--content-width')).toBe('960px');
  expect(lastPatch(posted)).toEqual({ contentWidth: 960 });

  const fontSize = panel.querySelector('[data-setting="fontSize"]');
  fontSize.value = '20';
  fontSize.dispatchEvent(new Event('input', { bubbles: true }));
  expect(style.getPropertyValue('--font-size')).toBe('20px');
  expect(lastPatch(posted)).toEqual({ fontSize: 20 });

  const lineHeight = panel.querySelector('[data-setting="lineHeight"]');
  lineHeight.value = '1.9';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  expect(style.getPropertyValue('--line-height')).toBe('1.9');
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
});

it('无标题文档显示「此文档没有标题」且 TOC 为空', () => {
  const { root, shell } = mount();
  load(shell, { markdown: '只有正文，没有标题。' });

  expect(root.querySelectorAll('#toc a')).toHaveLength(0);
  const empty = root.querySelector('#toc .toc-empty');
  expect(empty).toBeTruthy();
  expect(empty.textContent).toBe('此文档没有标题');
});

it('长 TOC（350 项）正常生成不崩', () => {
  const { root, shell, posted } = mount();
  const markdown = Array.from({ length: 350 }, (_, index) => `# 标题${index}`).join('\n\n');
  load(shell, { markdown });

  const links = root.querySelectorAll('#toc a');
  expect(links).toHaveLength(350);
  expect(links[349].getAttribute('href')).toBe('#标题349');
  const done = posted.find((message) => message.type === 'renderDone');
  expect(done.payload.tocCount).toBe(350);
});
