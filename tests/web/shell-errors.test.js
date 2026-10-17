// 修复波 B-前端功能缺口（§5.11 错误态 / 空白启动 / 大文件横幅 / TOC 空 slug / 键盘可达性 / 持久设置）。
// 只测 shell 层行为（渲染细节在 chunk/print/sanitize 各自用例里）。

import { dispatchWebMessage } from '../../web/src/index.js';

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
      markdown: '# 标题\n正文',
      settings: {},
      position: null,
      ...overrides,
    },
  });
}

function press(key, modifiers = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  document.body.dispatchEvent(event);
  return event;
}

/** IntersectionObserver 桩（jsdom 无该 API；有桩才能保留「剩余块未渲染」状态）。 */
function installObserverStub() {
  const previous = globalThis.IntersectionObserver;
  class FakeIntersectionObserver {
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

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('§5.11 渲染异常兜底与错误条', () => {
  it('renderMarkdown 抛错：转义 <pre> 兜底 + 持久错误条 + 照常发 renderDone', () => {
    const { root, shell, posted } = mount();
    const original = JJ.renderMarkdown;
    JJ.renderMarkdown = () => {
      throw new Error('boom');
    };
    try {
      shell.onMessage({
        type: 'load',
        payload: {
          path: 'bad.md',
          key: 'k',
          baseUrl: 'https://md.local/',
          markdown: '# 标题\n<script>alert(1)</script>',
          settings: {},
          position: null,
        },
      });
    } finally {
      JJ.renderMarkdown = original;
    }

    const content = root.querySelector('#content');
    const fallback = content.querySelector('pre.jj-fallback');
    expect(fallback).toBeTruthy();
    // 原文按文本展示，绝不能当 HTML 执行
    expect(fallback.textContent).toContain('<script>alert(1)</script>');
    expect(content.querySelector('script')).toBeNull();

    const bar = root.querySelector('#error-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.textContent).toContain('渲染失败');

    const done = posted.find((message) => message.type === 'renderDone');
    expect(done).toBeTruthy();
    expect(done.payload.path).toBe('bad.md');
  });

  it('分块渲染单块失败：该块降级纯文本，后续块继续渲染', () => {
    const observer = installObserverStub();
    const originalSplit = JJ.splitBlocks;
    const originalRender = JJ.renderMarkdown;
    const originalThreshold = JJ.CHUNK_THRESHOLD;
    const originalInitial = JJ.INITIAL_BYTES;
    JJ.splitBlocks = () => ({
      blocks: ['# 第一块\n\n', 'BAD 第二块\n\n', '## 第三块\n\n正文\n'],
      totalBytes: 64,
    });
    JJ.renderMarkdown = (source) => {
      if (String(source).includes('BAD')) {
        throw new Error('block boom');
      }
      return `<p>${String(source).trim()}</p>`;
    };
    JJ.CHUNK_THRESHOLD = 1;
    JJ.INITIAL_BYTES = 1; // 首屏只渲染第一块
    try {
      const { root, shell } = mount();
      load(shell, { markdown: '# 第一块\n\nBAD 第二块\n\n## 第三块\n\n正文\n' });
      expect(JJ.__ensureAllRendered()).toBe(true);
      const content = root.querySelector('#content');
      // 失败块保留原文（转义），后续块照常渲染
      expect(content.querySelector('pre.jj-fallback').textContent).toContain('BAD 第二块');
      expect(content.textContent).toContain('第三块');
      const bar = root.querySelector('#error-bar');
      expect(bar.hidden).toBe(false);
      expect(bar.textContent).toContain('部分内容渲染失败');
    } finally {
      JJ.splitBlocks = originalSplit;
      JJ.renderMarkdown = originalRender;
      JJ.CHUNK_THRESHOLD = originalThreshold;
      JJ.INITIAL_BYTES = originalInitial;
      observer.restore();
    }
  });

  it('notice.persistent 显示为可关闭错误条；新 load 收起旧错误条', () => {
    const { root, shell } = mount();
    shell.onMessage({
      type: 'notice',
      payload: { text: '文件编码可能不是 UTF-8，部分字符已替换', level: 'warn', persistent: true },
    });
    const bar = root.querySelector('#error-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('文件编码可能不是 UTF-8');
    expect(bar.dataset.level).toBe('warn');

    bar.querySelector('.notice-close').click();
    expect(bar.hidden).toBe(true);

    shell.onMessage({ type: 'notice', payload: { text: '打不开', level: 'error', persistent: true } });
    expect(bar.hidden).toBe(false);
    load(shell, { markdown: '# 新文档' });
    expect(bar.hidden).toBe(true);
  });

  it('notice.persistent=false 退回 toast（不占错误条）', () => {
    const { root, shell } = mount();
    shell.onMessage({ type: 'notice', payload: { text: '普通提示', persistent: false } });

    expect(root.querySelector('#error-bar').hidden).toBe(true);
    expect(root.querySelector('#toast').textContent).toContain('普通提示');
  });

  it('宿主消息处理抛错被 onMessage 捕获（shell 不崩）', () => {
    const { root, shell } = mount();
    const original = root.querySelector('#recent-menu');
    // 构造一个会抛错的分支：dirListing 交给 browse.applyListing，桩掉 normalize 不可行；
    // 这里用 getter 让 payload.items 读取抛错，验证 onMessage 的 try/catch。
    const message = { type: 'recent', payload: {} };
    Object.defineProperty(message.payload, 'items', {
      configurable: true,
      get() {
        throw new Error('bad payload');
      },
    });
    expect(() => shell.onMessage(message)).not.toThrow();
    expect(root.querySelector('#error-bar').hidden).toBe(false);
    expect(original).toBeTruthy();
  });

  it('dispatchWebMessage 捕获 onMessage 异常（boot 消息监听兜底）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = {
      onMessage() {
        throw new Error('listener boom');
      },
    };
    expect(() => dispatchWebMessage(shell, { type: 'load' })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('§5.11 空白启动与大文件横幅', () => {
  it('空白启动页提供「打开文件」按钮，点击发送 pickFile', () => {
    const { root, posted } = mount();
    const button = root.querySelector('#content .recent-open');
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('打开文件');
    button.click();
    expect(posted.some((message) => message.type === 'pickFile')).toBe(true);
  });

  it('大文件模式显示常驻横幅，可关闭；普通文档自动隐藏', () => {
    const { root, shell } = mount();
    const originalIsHuge = JJ.isHuge;
    let huge = true;
    JJ.isHuge = () => huge;
    try {
      load(shell, { markdown: '# 大文件' });
      const banner = root.querySelector('#huge-banner');
      expect(banner.hidden).toBe(false);
      expect(banner.textContent).toContain('大文件模式');
      banner.querySelector('.notice-close').click();
      expect(banner.hidden).toBe(true);

      huge = false;
      load(shell, { markdown: '# 普通文档' });
      expect(banner.hidden).toBe(true);
    } finally {
      JJ.isHuge = originalIsHuge;
    }
  });
});

describe('分块 TOC 空 slug 死链', () => {
  it('纯标点标题分配 section-N，侧栏与 [TOC] 都不再 href="#"（且避开真实 section-1）', () => {
    const originalThreshold = JJ.CHUNK_THRESHOLD;
    const originalInitial = JJ.INITIAL_BYTES;
    JJ.CHUNK_THRESHOLD = 1;
    JJ.INITIAL_BYTES = 1024 * 1024;
    try {
      const { root, shell } = mount();
      // 先有一个真实 id 为 section-1 的标题，空 slug 兜底必须跳到 section-2，不能撞车
      load(shell, { markdown: '## section 1\n\n## ！！！\n\n正文\n\n[TOC]\n' });

      const sidebarLinks = [...root.querySelectorAll('#toc-nav nav.toc a')];
      expect(sidebarLinks.map((link) => link.getAttribute('href'))).toEqual(['#section-1', '#section-2']);

      const inlineLinks = [...root.querySelectorAll('#content nav.toc-inline a')];
      expect(inlineLinks.map((link) => link.getAttribute('href'))).toEqual(['#section-1', '#section-2']);
      expect(inlineLinks.every((link) => link.getAttribute('href') !== '#')).toBe(true);

      // 正文标题实际 id 与 TOC 一致（点击能定位）
      const headingIds = [...root.querySelectorAll('#content h2')].map((heading) => heading.id);
      expect(headingIds).toEqual(['section-1', 'section-2']);
    } finally {
      JJ.CHUNK_THRESHOLD = originalThreshold;
      JJ.INITIAL_BYTES = originalInitial;
    }
  });
});

describe('工具栏键盘可达性与新增快捷键', () => {
  it('焦点进入工具条时显示工具条，且鼠标移出后不自动隐藏', () => {
    vi.useFakeTimers();
    const { root } = mount();
    expect(root.dataset.toolbar).toBe('hidden');

    const openFile = root.querySelector('#open-file');
    openFile.focus();
    expect(root.dataset.toolbar).toBe('shown');

    const toolbar = root.querySelector('#toolbar');
    toolbar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    vi.advanceTimersByTime(900);
    expect(root.dataset.toolbar).toBe('shown');
  });

  it('Alt+T 循环主题，Alt+A 打开关于', () => {
    const { shell, posted } = mount();
    load(shell);

    const themeEvent = press('t', { altKey: true });
    expect(themeEvent.defaultPrevented).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(posted.some((message) => message.type === 'saveSettings')).toBe(true);

    const aboutEvent = press('a', { altKey: true });
    expect(aboutEvent.defaultPrevented).toBe(true);
    expect(posted.some((message) => message.type === 'openAbout')).toBe(true);
  });
});

describe('空白启动应用持久设置', () => {
  it('收到 settings 消息后主题与字号立即生效（未打开文档）', () => {
    const { root } = mount();
    expect(root.querySelector('#content .recent-panel')).toBeTruthy();

    const shell = mounted[mounted.length - 1];
    shell.onMessage({ type: 'settings', payload: { theme: 'dark', fontSize: 20 } });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('20px');
  });
});
