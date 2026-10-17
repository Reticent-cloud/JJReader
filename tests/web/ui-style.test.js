// 界面美化波：两套界面风格（reader / whale）的切换、持久化、Aa 面板同步与装饰层。
// 只验证 JS 行为（data-ui-style / saveSettings patch / DOM 装饰）；颜色与布局由 CSS 承担，jsdom 不做视觉断言。
// 视觉细节（背景对比、装饰不遮挡、打印纯白、mascot 显示）见 docs/verify-checklist.md 的手测项。

const mounted = [];

function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

function mount() {
  const root = createRoot();
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
  mounted.push(shell);
  return { root, shell, posted };
}

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

function saveSettingsMessages(posted) {
  return posted.filter((message) => message.type === 'saveSettings');
}

function lastPatch(posted) {
  const messages = saveSettingsMessages(posted);
  return messages.length > 0 ? messages.at(-1).payload.patch : undefined;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('print-mode');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-style');
  delete window.matchMedia;
  delete window.ResizeObserver;
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.classList.remove('print-mode');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-style');
  delete window.matchMedia;
});

it('applyUiStyle 写入 data-ui-style；未知值回退 reader', () => {
  expect(JJ.applyUiStyle('whale')).toBe('whale');
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');

  expect(JJ.applyUiStyle('reader')).toBe('reader');
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');

  expect(JJ.applyUiStyle('rainbow')).toBe('reader');
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');

  expect(JJ.applyUiStyle(undefined)).toBe('reader');
  expect(JJ.applyUiStyle(null)).toBe('reader');
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');
});

it('normalizeUiStyle / nextUiStyle / uiStyleLabel 的两态口径', () => {
  expect(JJ.normalizeUiStyle('whale')).toBe('whale');
  expect(JJ.normalizeUiStyle('reader')).toBe('reader');
  expect(JJ.normalizeUiStyle('bogus')).toBe('reader');
  expect(JJ.nextUiStyle('reader')).toBe('whale');
  expect(JJ.nextUiStyle('whale')).toBe('reader');
  expect(JJ.nextUiStyle('bogus')).toBe('whale');
  expect(JJ.uiStyleLabel('reader')).toBe('阅读器风');
  expect(JJ.uiStyleLabel('whale')).toBe('鲸鱼娘');
  expect(JJ.uiStyleLabel('bogus')).toBe('阅读器风');
});

it('applySettings 也会应用 uiStyle（任何设置路径都保持风格一致）', () => {
  JJ.applySettings({ uiStyle: 'whale' });
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  JJ.applySettings({ uiStyle: 'nope', fontSize: 18 });
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');
});

it('mascot SVG 是原创内联常量：no external resource / script / image', () => {
  const svgs = [JJ.MASCOT_SVG, JJ.MASCOT_LARGE_SVG];
  for (const svg of svgs) {
    expect(typeof svg).toBe('string');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox=');
    // xmlns 是命名空间声明，不是网络资源；这里只禁止真正会发起请求/执行脚本的写法。
    expect(svg).not.toMatch(/(?:href|src)\s*=/i);
    expect(svg).not.toContain('url(');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('<use');
  }
  expect(JJ.MASCOT_SVG).toContain('viewBox="0 0 64 64"');
  expect(JJ.MASCOT_LARGE_SVG).toContain('viewBox="0 0 220 220"');
  // 鲸鱼娘元素：鲸尾、头饰、发丝、气泡（至少在字符串里各出现一次对应造型）
  expect(JJ.MASCOT_SVG).toContain('fill="#2A44B8"'); // 鲸尾
  expect(JJ.MASCOT_SVG).toContain('fill="#E2ECFF"'); // 荷叶边
  expect(JJ.MASCOT_SVG).toContain('fill="#9BD8FF"'); // 气泡
});

it('bubbleDecor 只返回常量装饰 HTML，count 夹紧到 0–24', () => {
  expect(JJ.bubbleDecor(3).match(/jj-bubble/g)).toHaveLength(3);
  expect(JJ.bubbleDecor(100).match(/jj-bubble/g)).toHaveLength(24);
  expect(JJ.bubbleDecor(-5)).not.toContain('jj-bubble');
  expect(JJ.bubbleDecor('abc')).not.toContain('jj-bubble');
  expect(JJ.bubbleDecor(0)).not.toContain('jj-bubble');
  const html = JJ.bubbleDecor(2);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('bubble-field');
  // 样式值只有数字，不接受外部字符串注入
  expect(html).not.toMatch(/[<>]script/i);
});

it('shell 装配装饰层：气泡 + 水印，aria-hidden 且不接收指针事件（CSS）', () => {
  const { root } = mount();
  const decor = root.querySelector('#ui-decor');
  expect(decor).toBeTruthy();
  expect(decor.getAttribute('aria-hidden')).toBe('true');
  expect(decor.querySelectorAll('.jj-bubble')).toHaveLength(14);
  expect(decor.querySelector('.ui-watermark svg')).toBeTruthy();
  // 空白页默认是最近文件面板（含空状态 mascot）
  expect(root.querySelector('#content .recent-mascot svg')).toBeTruthy();
  // 工具栏左侧小吉祥物 + Aa 面板的界面风格下拉
  expect(root.querySelector('#toolbar .toolbar-mascot svg')).toBeTruthy();
  const select = root.querySelector('#aa-panel [data-setting="uiStyle"]');
  expect(select).toBeTruthy();
  expect(select.value).toBe('reader');
});

it('工具条「🐳 主题」在 reader ↔ whale 间切换，只发 {uiStyle}', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const button = root.querySelector('#toolbar #ui-style-toggle');
  expect(button).toBeTruthy();
  expect(button.textContent).toContain('主题');
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');

  button.click();
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  expect(lastPatch(posted)).toEqual({ uiStyle: 'whale' });
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.title).toContain('鲸鱼娘');

  button.click();
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');
  expect(lastPatch(posted)).toEqual({ uiStyle: 'reader' });
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(button.title).toContain('阅读器风');
  // 只发 uiStyle，不夹带其它字段
  expect(Object.keys(lastPatch(posted))).toEqual(['uiStyle']);
});

it('Aa 面板「界面风格」下拉切换并同步工具条状态', () => {
  const { root, shell, posted } = mount();
  load(shell);
  const panel = root.querySelector('#aa-panel');
  const select = panel.querySelector('[data-setting="uiStyle"]');
  const button = root.querySelector('#toolbar #ui-style-toggle');

  select.value = 'whale';
  select.dispatchEvent(new Event('change', { bubbles: true }));

  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  expect(lastPatch(posted)).toEqual({ uiStyle: 'whale' });
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(select.value).toBe('whale');

  // 工具条切换 → 面板下拉回显（syncAaControls）
  button.click();
  expect(select.value).toBe('reader');
  expect(lastPatch(posted)).toEqual({ uiStyle: 'reader' });
});

it('settings 消息在空白启动时应用 uiStyle（宿主 preferences 先到）', () => {
  const { root, shell, posted } = mount();
  shell.onMessage({ type: 'settings', payload: { uiStyle: 'whale', theme: 'dark' } });
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  expect(root.querySelector('[data-setting="uiStyle"]').value).toBe('whale');
  expect(root.querySelector('#toolbar #ui-style-toggle').getAttribute('aria-pressed')).toBe('true');
  expect(saveSettingsMessages(posted)).toHaveLength(0);

  // 未知值回退 reader
  shell.onMessage({ type: 'settings', payload: { uiStyle: 'unknown-style' } });
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('reader');
});

it('load 下发的 settings.uiStyle 在渲染前应用', () => {
  const { root, shell } = mount();
  load(shell, { settings: { uiStyle: 'whale' } });
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  expect(root.querySelector('[data-setting="uiStyle"]').value).toBe('whale');
  expect(root.querySelector('#toolbar #ui-style-toggle').title).toContain('鲸鱼娘');
});

it('打印模式不重置界面风格，退出后 data-ui-style 仍在', () => {
  const { root, shell } = mount();
  load(shell, { settings: { uiStyle: 'whale' } });
  const exit = JJ.enterPrintMode();
  expect(document.body.classList.contains('print-mode')).toBe(true);
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
  exit();
  expect(document.body.classList.contains('print-mode')).toBe(false);
  expect(document.documentElement.getAttribute('data-ui-style')).toBe('whale');
});
