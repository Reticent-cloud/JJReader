// Task 11：大文档分块渲染与大文件模式（web/src/chunk.js + shell 集成 + engine 关闭高亮）。
// 设计口径（Controller 决策）：
//   - 切块零丢失（blocks.join('') === 原文）：先按标题切、再按空行段落切、仍超长按行切；
//     围栏代码块（``` / ~~~）与连续表格行整块不切；
//   - 首屏预算 initialBytes 按**渲染出的 HTML 字节数**计（真正的首屏成本），且首块无条件渲染（不空屏）；
//   - jsdom 没有真实布局 / IntersectionObserver：观察器一律由用例桩注入，标题 offsetTop 用 defineProperty 桩。

const CHUNK_LIMIT = 512 * 1024;
const HUGE_LIMIT = 20 * 1024 * 1024;

/** markdown 文本的 UTF-8 字节数（与 shell renderDone.bytes 口径一致）。 */
function utf8Length(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// ── 大文档生成（缩小版，约 1–2 MB，超过分块阈值但远小于 huge 阈值） ──

const SECTIONS = 50;
const FILLER = 400;
const TOTAL_HEADINGS = SECTIONS + 2; // # 大文档 + 50 个小节 + ## 末尾标题

let cachedDoc = null;
function largeDoc() {
  if (cachedDoc) {
    return cachedDoc;
  }
  const lines = ['# 大文档', '', '[TOC]', ''];
  for (let i = 0; i < SECTIONS; i += 1) {
    lines.push(`## 小节${i}`, '', `正文第 ${i} 段：分块渲染与首屏耗时验证。`, '');
    lines.push('```js', `const value${i} = ${i};`, '```', '');
    for (let j = 0; j < FILLER; j += 1) {
      lines.push(`- 第 ${i}-${j} 项：鲸鲸阅读器分块渲染测试内容，用于撑大文档体积。`);
    }
    lines.push('');
  }
  lines.push('## 末尾标题', '', '末尾段落标记 END-MARKER', '');
  cachedDoc = lines.join('\n');
  return cachedDoc;
}

// ── shell 装配（每个用例独立 #app；afterEach 统一 destroy 卸全局监听） ──

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

function load(shell, markdown, overrides = {}) {
  shell.onMessage({
    type: 'load',
    payload: {
      path: 'huge.md',
      key: 'k',
      baseUrl: 'https://md.local/',
      markdown,
      settings: {},
      position: null,
      ...overrides,
    },
  });
}

/** IntersectionObserver 桩：记录回调与 observe/disconnect 次数，手动触发「哨兵进入视口」。 */
function installObserverStub() {
  const state = { callback: null, observed: 0, disconnected: 0 };
  class FakeIntersectionObserver {
    constructor(callback) {
      state.callback = callback;
    }

    observe() {
      state.observed += 1;
    }

    unobserve() {}

    disconnect() {
      state.disconnected += 1;
    }
  }
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  return {
    state,
    trigger() {
      if (typeof state.callback === 'function') {
        state.callback([{ isIntersecting: true }]);
      }
    },
    restore() {
      if (previous === undefined) {
        delete globalThis.IntersectionObserver;
      } else {
        globalThis.IntersectionObserver = previous;
      }
    },
  };
}

/** 桩 heading 的 offsetTop：文本命中时返回指定值，其余 0（jsdom 无布局）。 */
function stubHeadingTop(text, top) {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetTop');
  Object.defineProperty(proto, 'offsetTop', {
    configurable: true,
    get() {
      return (this.textContent || '').trim() === text ? top : 0;
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

/** 临时把 JJ.isHuge 换成固定值（避免在单测里构造 20 MB 字符串），返回恢复函数。 */
function stubIsHuge(value) {
  const original = JJ.isHuge;
  JJ.isHuge = () => value;
  return () => {
    JJ.isHuge = original;
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('huge-mode');
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.classList.remove('huge-mode');
});

// ── splitBlocks ──

describe('splitBlocks', () => {
  it('不切断围栏代码块（每块围栏配对平衡）', () => {
    const fence = '```js\n' + 'const a = 1;\n'.repeat(4000) + '```\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 1024 });
    for (const block of blocks) {
      const fences = (block.match(/^```/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
    expect(blocks.join('')).toBe(fence); // 内容零丢失
  });

  it('不把表格行切到两块之外', () => {
    const table = '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(3000);
    for (const block of JJ.splitBlocks(table, { maxBlockBytes: 512 }).blocks) {
      if (block.includes('| 1 | 2 |')) {
        expect(block.startsWith('| a | b |')).toBe(true); // 表头与数据在同一块
      }
    }
  });

  it('大文件阈值判定', () => {
    expect(JJ.isHuge('a'.repeat(JJ.HUGE_THRESHOLD))).toBe(true);
    expect(JJ.isHuge('# hi')).toBe(false);
  });

  it('导出任务 11 的阈值常量（逐字）', () => {
    expect(JJ.CHUNK_THRESHOLD).toBe(CHUNK_LIMIT);
    expect(JJ.INITIAL_BYTES).toBe(256 * 1024);
    expect(JJ.MAX_BLOCK_BYTES).toBe(64 * 1024);
    expect(JJ.HUGE_THRESHOLD).toBe(HUGE_LIMIT);
  });

  it('空文档返回空块列表且零丢失', () => {
    const { blocks, totalBytes } = JJ.splitBlocks('');
    expect(blocks).toEqual([]);
    expect(blocks.join('')).toBe('');
    expect(totalBytes).toBe(0);
  });

  it('短文档原样一块返回', () => {
    const markdown = '# 标题\n\n正文段落。\n';
    const { blocks, totalBytes } = JJ.splitBlocks(markdown);
    expect(blocks).toEqual([markdown]);
    expect(totalBytes).toBe(utf8Length(markdown));
  });

  it('超长单行不产生空块（无法按行切时整行保留）', () => {
    const line = 'x'.repeat(300 * 1024);
    const { blocks } = JJ.splitBlocks(line, { maxBlockBytes: 1024 });
    expect(blocks).toEqual([line]);
    expect(blocks.join('')).toBe(line);
  });

  it('只有代码块的文档整块保留且围栏配对', () => {
    const fence = '```ts\n' + 'const value = 1;\n'.repeat(2000) + '```\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 512 });
    expect(blocks).toHaveLength(1);
    expect((blocks[0].match(/^```/gm) ?? []).length).toBe(2);
    expect(blocks.join('')).toBe(fence);
  });

  it('只有表格的文档表格不跨块', () => {
    const table = '| 列一 | 列二 |\n| --- | --- |\n' + '| 甲 | 乙 |\n'.repeat(1200);
    const { blocks } = JJ.splitBlocks(table, { maxBlockBytes: 512 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startsWith('| 列一 | 列二 |')).toBe(true);
    expect(blocks.join('')).toBe(table);
  });

  it('围栏用 ~~~ 时同样不切断', () => {
    const fence = '~~~md\n' + '内容行\n'.repeat(2000) + '~~~\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 1024 });
    for (const block of blocks) {
      expect((block.match(/^~~~/gm) ?? []).length % 2).toBe(0);
    }
    expect(blocks.join('')).toBe(fence);
  });

  it('标题行优先作为块边界（块从标题开始）', () => {
    // 每段都 ≤ 上限（不会触发段内再切）：合并只能发生在整段之间，因此每个块都从标题行开始
    const markdown =
      '## 一\n' + '甲\n'.repeat(150) + '\n## 二\n' + '乙\n'.repeat(150) + '\n## 三\n' + '丙\n'.repeat(150) + '\n';
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 1024 });
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(/^#{1,6}\s/.test(block)).toBe(true);
    }
    expect(blocks.join('')).toBe(markdown);
  });

  it('5 万行文档切块零丢失、每块不超过上限', () => {
    const markdown = Array.from({ length: 50000 }, (_, i) => `第 ${i} 行内容`).join('\n');
    const { blocks, totalBytes } = JJ.splitBlocks(markdown);
    expect(blocks.join('')).toBe(markdown);
    expect(totalBytes).toBe(utf8Length(markdown));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(JJ.MAX_BLOCK_BYTES);
    }
  });

  it('混合文档（标题/表格/围栏/列表）切块后零丢失且围栏配对', () => {
    const parts = [];
    for (let i = 0; i < 20; i += 1) {
      parts.push(`## 段${i}`, '');
      parts.push('正文'.repeat(200), '');
      parts.push('```js', 'const a = 1;', '```', '');
      parts.push('| a | b |', '|---|---|', '| 1 | 2 |', '');
      parts.push('- 清单项', '');
    }
    const markdown = parts.join('\n');
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 2048 });
    expect(blocks.join('')).toBe(markdown);
    for (const block of blocks) {
      expect((block.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
  });
});

// ── createChunkedRenderer ──

describe('createChunkedRenderer', () => {
  function makeRenderer(overrides = {}) {
    const container = overrides.container ?? document.createElement('div');
    document.body.append(container);
    const calls = [];
    const observer = { trigger: null, disconnectCount: 0, observeCount: 0 };
    const observerFactory = (onIntersect) => {
      observer.trigger = onIntersect;
      return {
        observe() {
          observer.observeCount += 1;
        },
        disconnect() {
          observer.disconnectCount += 1;
        },
      };
    };
    const renderer = JJ.createChunkedRenderer({
      container,
      render: (md) => `<section>${md}</section>`,
      onChunkRendered: (info) => calls.push(info),
      observerFactory,
      ...overrides,
    });
    return { container, renderer, observer, calls };
  }

  it('渐进渲染：首屏只渲染首块，观察器触发后续', () => {
    const container = document.createElement('div');
    let trigger = null;
    const observerFactory = (onIntersect) => {
      trigger = onIntersect;
      return { observe() {}, disconnect() {} };
    };
    const r = JJ.createChunkedRenderer({
      container,
      render: (md) => `<section>${md}</section>`,
      blocks: ['A', 'B', 'C'],
      initialBytes: 16,
      observerFactory,
    });
    r.start();
    expect(r.renderedCount()).toBe(1);
    trigger(); // 模拟哨兵进入视口
    expect(container.innerHTML).toContain('B');
  });

  it('initialBytes 小到 0 时仍渲染首块（不空屏）', () => {
    const { container, renderer } = makeRenderer({ blocks: ['甲', '乙', '丙'], initialBytes: 0 });
    renderer.start();
    expect(renderer.renderedCount()).toBe(1);
    expect(container.textContent).toContain('甲');
    expect(container.textContent).not.toContain('丙');
  });

  it('首屏按 initialBytes（HTML 字节）预算渲染多块', () => {
    // <section>x</section> = 21 字节；预算 50 字节 → 渲染 2 块（42 ≤ 50，第三块 63 > 50）
    const { container, renderer } = makeRenderer({ blocks: ['A', 'B', 'C'], initialBytes: 50 });
    renderer.start();
    expect(renderer.renderedCount()).toBe(2);
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
    expect(container.textContent).not.toContain('C');
    expect(container.querySelector('.chunk-sentinel')).toBeTruthy();
  });

  it('观察器多次触发逐块渲染，全部渲染后移除哨兵并断开', () => {
    const { container, renderer, observer } = makeRenderer({ blocks: ['甲', '乙', '丙'], initialBytes: 0 });
    renderer.start();
    expect(renderer.renderedCount()).toBe(1);
    observer.trigger();
    expect(renderer.renderedCount()).toBe(2);
    observer.trigger();
    expect(renderer.renderedCount()).toBe(3);
    expect(container.querySelector('.chunk-sentinel')).toBeNull();
    expect(observer.disconnectCount).toBeGreaterThan(0);
    observer.trigger(); // 已完成后再触发是空操作
    expect(renderer.renderedCount()).toBe(3);
  });

  it('renderAll() 渲染全部块、移除哨兵、DOM 顺序与 blocks 一致', () => {
    const blocks = ['甲', '乙', '丙', '丁', '戊'];
    const { container, renderer, observer, calls } = makeRenderer({ blocks, initialBytes: 30 });
    renderer.start();
    expect(renderer.renderedCount()).toBeLessThan(blocks.length);
    renderer.renderAll();
    expect(renderer.renderedCount()).toBe(blocks.length);
    expect(container.querySelector('.chunk-sentinel')).toBeNull();
    const rendered = [...container.querySelectorAll('section')].map((node) => node.textContent);
    expect(rendered).toEqual(blocks);
    expect(calls.map((info) => info.index)).toEqual([0, 1, 2, 3, 4]);
    expect(observer.disconnectCount).toBeGreaterThan(0);
    renderer.renderAll(); // 幂等
    expect(renderer.renderedCount()).toBe(blocks.length);
  });

  it('每块渲染后回调 onChunkRendered（含序号）', () => {
    const { renderer, calls, observer } = makeRenderer({ blocks: ['A', 'B', 'C'], initialBytes: 0 });
    renderer.start();
    observer.trigger();
    expect(calls.map((info) => info.index)).toEqual([0, 1]);
  });

  it('空块列表不抛异常、无哨兵、计数为 0', () => {
    const { container, renderer } = makeRenderer({ blocks: [], initialBytes: 0 });
    renderer.start();
    expect(renderer.renderedCount()).toBe(0);
    expect(container.querySelector('.chunk-sentinel')).toBeNull();
    renderer.renderAll();
    expect(renderer.renderedCount()).toBe(0);
  });

  it('start 是幂等的（不会重复渲染首屏）', () => {
    const { renderer } = makeRenderer({ blocks: ['A', 'B'], initialBytes: 0 });
    renderer.start();
    renderer.start();
    expect(renderer.renderedCount()).toBe(1);
  });
});

// ── engine：关闭高亮（大文件模式） ──

describe('engine disableHighlight', () => {
  it('默认仍输出 highlight.js 的 token span 与复制按钮', () => {
    const html = JJ.renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('hljs-');
    expect(html).toContain('class="copy"');
  });

  it('disableHighlight 输出转义纯文本（无 hljs token），复制按钮结构保留', () => {
    const html = JJ.renderMarkdown('```js\nconst a = 1 < 2;\n```', { disableHighlight: true });
    expect(html).not.toContain('hljs-');
    const host = document.createElement('div');
    host.innerHTML = html;
    const code = host.querySelector('.code-wrap code');
    expect(code).toBeTruthy();
    expect(code.querySelectorAll('span')).toHaveLength(0);
    expect(code.textContent).toBe('const a = 1 < 2;\n');
    const button = host.querySelector('.code-wrap button.copy');
    expect(button).toBeTruthy();
    expect(button.dataset.code).toBe('const a = 1 < 2;\n');
  });

  it('env.tocHeadings 让分块渲染的 [TOC] 仍列出全文标题', () => {
    const headings = [
      { id: '一', text: '一', level: 1 },
      { id: '二', text: '二', level: 2 },
    ];
    const html = JJ.renderMarkdown('[TOC]', { tocHeadings: headings });
    expect((html.match(/toc-inline/g) ?? []).length).toBe(1);
    expect(html).toContain('href="#一"');
    expect(html).toContain('href="#二"');
  });
});

// ── shell 集成 ──

describe('shell 分块渲染与大文件模式', () => {
  it('大文档走分块：首屏只渲染前缀、renderDone/TOC/内联目录基于全文', () => {
    const observer = installObserverStub();
    try {
      const markdown = largeDoc();
      expect(markdown.length).toBeGreaterThan(JJ.CHUNK_THRESHOLD);
      const { root, shell, posted } = mount();
      load(shell, markdown);

      const content = root.querySelector('#content');
      expect(content.querySelector('.chunk-sentinel')).toBeTruthy();
      expect(content.textContent).toContain('小节0');
      expect(content.textContent).not.toContain('END-MARKER');
      expect(content.textContent).not.toContain('末尾段落标记');

      const done = posted.find((message) => message.type === 'renderDone');
      expect(done).toBeTruthy();
      expect(done.payload.path).toBe('huge.md');
      expect(done.payload.tocCount).toBe(TOTAL_HEADINGS);
      expect(done.payload.bytes).toBe(utf8Length(markdown));
      expect(done.payload.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(posted.filter((message) => message.type === 'renderDone')).toHaveLength(1);

      // TOC 侧栏基于全文 extractHeadings
      const sideLinks = [...root.querySelectorAll('#toc a')];
      expect(sideLinks).toHaveLength(TOTAL_HEADINGS);
      expect(sideLinks[0].getAttribute('href')).toBe('#大文档');
      expect(sideLinks.at(-1).getAttribute('href')).toBe('#末尾标题');

      // [TOC] 内联目录同样是全文（分块渲染不能破坏 T9）
      const inlineLinks = [...content.querySelectorAll('nav.toc-inline a')];
      expect(inlineLinks).toHaveLength(TOTAL_HEADINGS);

      // 非 huge：滚动联动启用，首屏至少有一条高亮
      expect(root.querySelectorAll('#toc a.active').length).toBeGreaterThan(0);
      expect(document.body.classList.contains('huge-mode')).toBe(false);
    } finally {
      observer.restore();
    }
  });

  it('点击靠后的 TOC：目标未渲染时 renderAll 后按实时 offsetTop 定位，每块都 enhance', () => {
    const observer = installObserverStub();
    const restoreTops = stubHeadingTop('末尾标题', 4000);
    try {
      const { root, shell, posted } = mount();
      load(shell, largeDoc());
      const content = root.querySelector('#content');
      const calls = [];
      content.scrollTo = (options) => calls.push(options);

      const lastLink = [...root.querySelectorAll('#toc a')].at(-1);
      expect(lastLink.getAttribute('href')).toBe('#末尾标题');
      lastLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(content.querySelector('.chunk-sentinel')).toBeNull();
      expect(content.textContent).toContain('END-MARKER');
      const target = content.querySelector('#末尾标题');
      expect(target).toBeTruthy();
      expect(calls.at(-1)).toEqual({ top: 4000 - 80, behavior: 'smooth' });

      // 每追加一块都调用过 enhance：后续块的复制按钮全部已绑定
      const buttons = [...content.querySelectorAll('.code-wrap button.copy')];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((button) => button.getAttribute('data-jj-enhanced') === '1')).toBe(true);
      // 后追加的标题 id 也已兜底赋值（可被 document.getElementById 定位）
      expect(document.getElementById('末尾标题')).toBe(target);
      // renderAll 不重发 renderDone（只报首屏）
      expect(posted.filter((message) => message.type === 'renderDone')).toHaveLength(1);
    } finally {
      restoreTops();
      observer.restore();
    }
  });

  it('分块模式下 front matter 属性块只挂一次且位于正文最前', () => {
    const observer = installObserverStub();
    try {
      const markdown = `---\ntitle: 大文档\ntags: [a, b]\n---\n\n${largeDoc()}`;
      const { root, shell } = mount();
      load(shell, markdown);
      const content = root.querySelector('#content');
      const details = content.querySelectorAll('details.frontmatter');
      expect(details).toHaveLength(1);
      expect(content.firstElementChild).toBe(details[0]);
      observer.trigger(); // 追加后续块不会重复挂属性块
      expect(content.querySelectorAll('details.frontmatter')).toHaveLength(1);
      expect(content.firstElementChild).toBe(details[0]);
    } finally {
      observer.restore();
    }
  });

  it('观察器触发后逐块追加内容且保持 DOM 顺序', () => {
    const observer = installObserverStub();
    try {
      const { root, shell } = mount();
      load(shell, largeDoc());
      const content = root.querySelector('#content');
      expect(content.textContent).not.toContain('END-MARKER');
      observer.trigger();
      const headings = [...content.querySelectorAll('h2')].map((node) => node.textContent.trim());
      // 追加后标题仍按文档顺序（新块插在哨兵之前）
      const expected = ['小节0', ...Array.from({ length: SECTIONS - 1 }, (_, i) => `小节${i + 1}`)];
      expect(headings).toEqual(expected.slice(0, headings.length));
      expect(content.textContent).not.toContain('END-MARKER');
    } finally {
      observer.restore();
    }
  });

  it('大文件模式：huge-mode、toast、关闭高亮、不启用滚动联动', () => {
    const restore = stubIsHuge(true);
    try {
      const { root, shell, posted } = mount();
      load(shell, '# 大标题\n\n```js\nconst a = 1 < 2;\n```\n\n正文内容');

      expect(document.body.classList.contains('huge-mode')).toBe(true);
      const toast = posted.find((message) => message.type === 'toast');
      expect(toast).toBeTruthy();
      expect(toast.payload).toEqual({ text: '大文件模式：已关闭代码高亮', level: 'warn' });
      expect(root.querySelector('#toast').textContent).toContain('大文件模式：已关闭代码高亮');

      const code = root.querySelector('#content .code-wrap code');
      expect(code).toBeTruthy();
      expect(code.querySelector('span')).toBeNull();
      expect(code.textContent).toContain('const a = 1 < 2;');
      expect(root.querySelector('#content .code-wrap button.copy')).toBeTruthy();

      // TOC 仍生成，但不启用滚动联动（没有任何 active 项）
      expect(root.querySelectorAll('#toc a')).toHaveLength(1);
      expect(root.querySelectorAll('#toc a.active')).toHaveLength(0);
      expect(root.querySelector('#toc a').getAttribute('href')).toBe('#大标题');
    } finally {
      restore();
    }
  });

  it('从大文件切回普通文档：清理 huge-mode 与分块状态，恢复高亮与滚动联动', () => {
    const restore = stubIsHuge(true);
    let root = null;
    let shell = null;
    try {
      ({ root, shell } = mount());
      load(shell, '# 大标题\n\n```js\nconst a = 1;\n```');
      expect(document.body.classList.contains('huge-mode')).toBe(true);
      expect(root.querySelector('#content .code-wrap code span')).toBeNull();
    } finally {
      restore();
    }

    load(shell, '# 普通标题\n\n```js\nconst a = 1;\n```\n\n正文');
    expect(document.body.classList.contains('huge-mode')).toBe(false);
    expect(root.querySelector('#content .chunk-sentinel')).toBeNull();
    expect(root.querySelector('#content .code-wrap code .hljs-keyword')).toBeTruthy();
    expect(root.querySelectorAll('#toc a.active').length).toBeGreaterThan(0);
  });

  it('未达到阈值的文档仍一次性渲染（不产生哨兵、不多发消息）', () => {
    const { root, shell, posted } = mount();
    load(shell, '# 小文档\n\n普通正文');
    expect(root.querySelector('#content .chunk-sentinel')).toBeNull();
    expect(root.querySelector('#content').textContent).toContain('普通正文');
    expect(posted.filter((message) => message.type === 'renderDone')).toHaveLength(1);
  });
});
