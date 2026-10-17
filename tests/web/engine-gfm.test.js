// GFM 完整语法用例（Task 6）：表格对齐、任务清单、脚注、emoji、代码高亮、未闭合围栏、代码复制与 enhance。
// 表格对齐口径按 Controller 决策 1：markdown-it 14 输出 style="text-align:center|right"（不是 align 属性）。
// 复制用例需要 navigator.clipboard / document.execCommand 的桩，统一在 afterEach 还原，避免污染其它文件。

const BASE_URL = 'https://md.local/';

/** 默认带虚拟主机 baseUrl 渲染（与宿主 load.baseUrl 一致）。 */
const html = (md) => JJ.renderMarkdown(md, { baseUrl: BASE_URL });

/** 渲染到独立 div 并挂到 body（enhance 作用于已渲染的 DOM 子树；jsdom 挂不挂载都能查询）。 */
function renderRoot(markdown) {
  const root = document.createElement('div');
  root.innerHTML = JJ.renderMarkdown(markdown, { baseUrl: BASE_URL });
  document.body.append(root);
  return root;
}

/** 等 async 复制流程（clipboard.writeText 的 Promise）跑完再断言按钮状态。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 给 navigator.clipboard 装桩（jsdom 默认没有 clipboard）；afterEach 统一删除。 */
function stubClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  // 还原桩：clipboard 与 execCommand 在 jsdom 里默认都不存在
  delete navigator.clipboard;
  delete document.execCommand;
  document.body.innerHTML = '';
});

describe('表格', () => {
  it('表格对齐保留到 th/td', () => {
    const out = html('| a | b |\n|:--:|--:|\n| 1 | 2 |');
    expect(out).toMatch(/<th[^>]*style="text-align:center"[^>]*>a<\/th>/);
    expect(out).toMatch(/<td[^>]*style="text-align:right"[^>]*>2<\/td>/);
  });
});

describe('任务清单', () => {
  it('任务清单生成 checkbox', () => {
    const out = html('- [ ] 未做\n- [x] 已做');
    expect(out).toMatch(/<input[^>]*type="checkbox"/);
    expect(out).toMatch(/<input[^>]*checked/);
  });

  it('任务清单 checkbox 只读（disabled）并带 GFM 类名', () => {
    const out = html('- [ ] 未做\n- [x] 已做');
    expect(out).toMatch(/<input[^>]*disabled/);
    expect(out).toContain('task-list-item');
    expect(out).toContain('contains-task-list');
  });
});

describe('脚注', () => {
  it('脚注生成上标与回链', () => {
    const out = html('正文[^1]\n\n[^1]: 注解内容');
    expect(out).toMatch(/<sup[^>]*>.*<\/sup>/s);
    expect(out).toContain('注解内容');
    expect(out).toContain('footnote-backref');
  });
});

describe('emoji', () => {
  it('表情短码渲染为 emoji 且标题文本不丢字', () => {
    expect(html('你好 :smile:')).toContain('😄');
    expect(JJ.extractHeadings('# 上线 :rocket:')[0].text).toBe('上线 🚀');
  });
});

describe('代码块高亮', () => {
  it('代码块高亮并带语言类', () => {
    const out = html('```js\nconst a = 1;\n```');
    expect(out).toMatch(/<code[^>]*class="[^"]*language-js/);
    expect(out).toMatch(/<span class="hljs-/);
  });

  it('未闭合围栏不崩且按代码渲染', () => {
    const out = html('```js\nconst a = 1;');
    expect(out).toContain('const a = 1;');
  });

  it('未给语言的围栏只有 hljs 类，不臆造 language-', () => {
    const out = html('```\nplain text\n```');
    expect(out).toContain('<code class="hljs">');
    expect(out).not.toContain('language-');
  });

  it('代码块内 HTML 被转义，不产生活标签', () => {
    const root = renderRoot('```\n<b>x</b>\n```');
    expect(root.querySelector('b')).toBeNull();
    expect(root.innerHTML).toContain('&lt;b&gt;');
  });

  it('已知语言的代码块同样转义 HTML，高亮不破坏转义', () => {
    const root = renderRoot('```js\nconst s = "<b>x</b>";\n```');
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('const s = "<b>x</b>";');
  });

  it('围栏语言串做属性转义，不注入额外属性', () => {
    const out = html('```js" onmouseover="evil\nx\n```');
    expect(out).not.toContain('onmouseover="');
    expect(out).toContain('language-js&quot;');
  });
});

describe('JJ.highlight', () => {
  it('已知语言输出 hljs span', () => {
    const out = JJ.highlight('const a = 1;', 'js');
    expect(out).toContain('<span class="hljs-');
    expect(out).toContain('const');
  });

  it('未知语言返回转义纯文本', () => {
    const out = JJ.highlight('<b>x</b>', 'nope');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });

  it('空语言返回转义纯文本', () => {
    const out = JJ.highlight('<b>x</b>');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });

  it.each([
    ['py', 'def foo(x):\n    return x'],
    ['cs', 'public class A { }'],
    ['sh', 'if [ -f x ]; then echo hi; fi'],
    ['yml', 'key: value'],
    ['html', '<div class="a">x</div>'],
    ['md', '# 标题'],
  ])('围栏语言别名 %s 能高亮（不降级为纯文本）', (lang, code) => {
    expect(JJ.highlight(code, lang)).toContain('hljs-');
  });
});

describe('代码复制按钮', () => {
  it('代码块渲染后出现复制按钮且取到原文', () => {
    const root = renderRoot('```js\nlet x=1;\n```');
    JJ.enhance(root, { baseUrl: BASE_URL });
    const btn = root.querySelector('button.copy');
    expect(btn).toBeTruthy();
    expect(btn.dataset.code).toContain('let x=1;');
  });

  it('data-code 属性级转义后能还原原始代码（& < > " \' 与换行）', () => {
    const code = '<a href="x">A & B</a>\nlet s = \'q\';';
    const markdown = `\`\`\`html\n${code}\n\`\`\``;
    // 渲染出的 HTML 字符串：属性值必须整段转义，不能把代码里的 <a 拆成标签
    const raw = html(markdown);
    expect(raw).toContain('data-code="&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
    expect(raw).toContain('&#39;q&#39;');

    // DOM 解析后：dataset.code 原样还原（含换行），且没有从属性值里漏出任何元素
    const root = renderRoot(markdown);
    JJ.enhance(root);
    const btn = root.querySelector('button.copy');
    // 闭合围栏的 token.content 含结尾换行（markdown-it 14 行为）
    expect(btn.dataset.code).toBe(`${code}\n`);
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
  });

  it('点击优先 navigator.clipboard.writeText，成功后标记 data-copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const root = renderRoot('```js\nlet x=1;\n```');
    JJ.enhance(root);

    root.querySelector('button.copy').click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('let x=1;');
    const btn = root.querySelector('button.copy');
    expect(btn.dataset.copied).toBe('1');
    expect(btn.dataset.failed).toBeUndefined();
  });

  it('clipboard 不可用且 execCommand 缺失时标记 data-failed，不抛异常', async () => {
    const root = renderRoot('```js\nlet x=1;\n```');
    JJ.enhance(root);
    const btn = root.querySelector('button.copy');

    expect(() => btn.click()).not.toThrow();
    await flush();

    expect(btn.dataset.failed).toBe('1');
    expect(btn.dataset.copied).toBeUndefined();
  });

  it('clipboard 失败时用隐藏 textarea + execCommand 兜底', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const root = renderRoot('```js\nlet x=1;\n```');
    JJ.enhance(root);

    root.querySelector('button.copy').click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('copy');
    const btn = root.querySelector('button.copy');
    expect(btn.dataset.copied).toBe('1');
    // 兜底用的 textarea 用完必须移除，不能留在文档里
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('enhance 幂等：重复调用不重复绑事件，按钮也不重复', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const root = renderRoot('```js\nlet x=1;\n```');
    JJ.enhance(root, { baseUrl: BASE_URL });
    JJ.enhance(root, { baseUrl: BASE_URL });

    expect(root.querySelectorAll('button.copy')).toHaveLength(1);
    root.querySelector('button.copy').click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('enhance 外链与 shell 集成', () => {
  it('外链加 target=_blank 与 rel=noopener', () => {
    const root = renderRoot('[外站](https://example.com)');
    JJ.enhance(root);
    const a = root.querySelector('a');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener');
  });

  it('站内相对链接不加 target', () => {
    const root = renderRoot('[内链](#标题)');
    JJ.enhance(root);
    expect(root.querySelector('a').getAttribute('target')).toBeNull();
  });

  it('shell 渲染后自动调用 enhance（复制按钮已打标记）', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const shell = JJ.mountShell({ root, post: () => {} });

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

    const btn = root.querySelector('#content button.copy');
    expect(btn).toBeTruthy();
    expect(btn.dataset.jjEnhanced).toBe('1');
  });

  it('JJ.enhance 缺失时 shell 照常渲染并回报 renderDone，不白屏', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const posted = [];
    const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
    const original = JJ.enhance;

    try {
      delete JJ.enhance;
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
    } finally {
      JJ.enhance = original;
    }

    expect(posted.some((m) => m.type === 'renderDone')).toBe(true);
    expect(root.querySelector('#content button.copy')).toBeTruthy();
  });
});
