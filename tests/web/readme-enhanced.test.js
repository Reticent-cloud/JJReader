// README 增强用例（Task 9）：AI README 常见内嵌 HTML、`[TOC]` 内联目录、图片占位、front matter 属性折叠块、标题锚点一致性。
// 口径（Controller 决策，brief 未定处以本文件锁定）：
//   - `[TOC]`/`[toc]` 独占一行（允许前后空白）→ <nav class="toc-inline"><ol><li data-level="n"><a href="#id">…</a></li></ol></nav>
//     扁平列表（不嵌套 <ol>）；无标题 → 空 <nav class="toc-inline"></nav>；代码块与普通段落里的 [TOC] 不转换。
//   - 图片 error → span.img-placeholder（data-alt 保存 alt 文本；img 上有 width/height 时沿用，否则内联 aspect-ratio:16/9）。
//   - front matter → shell 在 #content 顶部插 details.frontmatter（属性折叠块，默认折叠），值文本按纯文本转义。
//   - 标题锚点：T5 已生成 id，本任务只锁定「renderMarkdown 输出与 extractHeadings 的 id 一致」。

const BASE_URL = 'https://md.local/';

/** 渲染到独立 div（不挂 body）后用 DOM 断言，避免字符串序列化差异影响属性判断。 */
function renderRoot(markdown, env) {
  const root = document.createElement('div');
  root.innerHTML = JJ.renderMarkdown(markdown, { baseUrl: BASE_URL, ...env });
  return root;
}

/** 每个用例独立的 #app 容器（mountShell 的 root 就是 #app 本身）。 */
function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

function mountShell(root) {
  const posted = [];
  const shell = JJ.mountShell({
    root,
    post: (type, payload) => posted.push({ type, payload }),
  });
  return { shell, posted };
}

function loadPayload(overrides = {}) {
  return {
    path: 'a.md',
    key: 'k',
    baseUrl: BASE_URL,
    markdown: '# 标题\n正文',
    settings: {},
    position: null,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('AI README 内嵌 HTML', () => {
  it('details/summary 与内嵌语义标签保留', () => {
    const out = JJ.renderMarkdown(
      '<details><summary>点开</summary><p align="center"><kbd>Ctrl</kbd>+<sub>2</sub><sup>+</sup></p></details>',
    );
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>点开</summary>');
    expect(out).toContain('<kbd>Ctrl</kbd>');
    expect(out).toContain('<sub>2</sub>');
    expect(out).toContain('<sup>+</sup>');
  });

  it('清洗后 details open / div align / kbd 仍保留（T7 白名单端到端再锁一次）', () => {
    const root = renderRoot(
      '<details open><summary>展开</summary><div align="center"><kbd>Esc</kbd></div></details>',
    );
    const details = root.querySelector('details');
    expect(details).toBeTruthy();
    expect(details.hasAttribute('open')).toBe(true);
    expect(root.querySelector('summary').textContent).toBe('展开');
    expect(root.querySelector('div').getAttribute('align')).toBe('center');
    expect(root.querySelector('kbd').textContent).toBe('Esc');
  });

  it('emoji 短码与居中容器', () => {
    expect(JJ.renderMarkdown(':rocket: 发射')).toContain('🚀');
    expect(JJ.renderMarkdown('直接字符 🚀')).toContain('🚀');
    const out = JJ.renderMarkdown('<div align="center"><img src="logo.png"></div>', {
      baseUrl: BASE_URL,
    });
    expect(out).toContain('align="center"');
  });
});

describe('[TOC] 内联目录', () => {
  it('[TOC] 就地生成层级目录', () => {
    const html = JJ.renderMarkdown('# 一\n\n[TOC]\n\n## 一.一');
    expect(html).toContain('class="toc-inline"');
    expect(html).toContain('data-level="2"');
  });

  it('目录项按标题层级与锚点生成（扁平列表、无嵌套 ol）', () => {
    const md = '# 一\n\n[TOC]\n\n## 一.一\n\n### 一.一.一';
    const root = renderRoot(md);
    const nav = root.querySelector('nav.toc-inline');
    expect(nav).toBeTruthy();
    expect(nav.querySelectorAll('nav ol ol')).toHaveLength(0);

    const headings = JJ.extractHeadings(md);
    const items = [...nav.querySelectorAll('li')];
    expect(items.map((li) => li.dataset.level)).toEqual(headings.map((h) => String(h.level)));
    expect(items.map((li) => li.querySelector('a').getAttribute('href'))).toEqual(
      headings.map((h) => `#${h.id}`),
    );
    expect(items.map((li) => li.querySelector('a').textContent)).toEqual(
      headings.map((h) => h.text),
    );
  });

  it('小写 [toc] 与前后空白同样生效', () => {
    const html = JJ.renderMarkdown('  [toc]  \n\n# 标题');
    expect(html).toContain('class="toc-inline"');
    expect(html).toContain('href="#标题"');
  });

  it('[TOC] 在围栏代码块内不转换', () => {
    const html = JJ.renderMarkdown('```\n[TOC]\n```');
    expect(html).not.toContain('toc-inline');
    expect(html).toContain('[TOC]');
  });

  it('[TOC] 在缩进代码块/普通段落内不转换', () => {
    expect(JJ.renderMarkdown('    [TOC]')).not.toContain('toc-inline');
    const inline = JJ.renderMarkdown('见 [TOC] 目录');
    expect(inline).not.toContain('toc-inline');
    expect(inline).toContain('[TOC]');
  });

  it('无标题文档的 [TOC] 输出空 nav（固定口径）', () => {
    const html = JJ.renderMarkdown('[TOC]');
    expect(html).toContain('<nav class="toc-inline"></nav>');
    expect(html).not.toContain('<ol');
  });

  it('多个 [TOC] 各自生成一份完整目录', () => {
    const html = JJ.renderMarkdown('[TOC]\n\n# 甲\n\n[TOC]');
    expect(html.match(/class="toc-inline"/g)).toHaveLength(2);
    expect(html.match(/href="#甲"/g)).toHaveLength(2);
  });

  it('引用块里的 [TOC] 同样生成完整目录（预扫描要能识别 > 前缀）', () => {
    const html = JJ.renderMarkdown('> [TOC]\n\n# 标题');
    expect(html).toContain('<nav class="toc-inline"><ol>');
    expect(html).toContain('href="#标题"');
  });
});

describe('图片占位（离线/加载失败不破版）', () => {
  it('图片加载失败替换为占位框（离线不破版）', () => {
    const root = renderRoot('![徽章](https://img.shields.io/badge/a-b-green)');
    JJ.enhance(root, { baseUrl: BASE_URL });
    root.querySelector('img').dispatchEvent(new Event('error'));
    const placeholder = root.querySelector('.img-placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder.dataset.alt).toBe('徽章');
    expect(placeholder.textContent).toBe('徽章');
    expect(root.querySelector('img')).toBeFalsy();
  });

  it('img 加 loading="lazy" 与 decoding="async"', () => {
    const root = renderRoot('![图](pic.png)');
    JJ.enhance(root);
    const img = root.querySelector('img');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('已有 width/height 属性时占位保留尺寸', () => {
    const root = renderRoot('<img src="logo.png" width="120" height="40" alt="标志">');
    JJ.enhance(root);
    root.querySelector('img').dispatchEvent(new Event('error'));
    const placeholder = root.querySelector('.img-placeholder');
    expect(placeholder.style.width).toBe('120px');
    expect(placeholder.style.height).toBe('40px');
    expect(placeholder.dataset.alt).toBe('标志');
  });

  it('已有内联 style 宽高时占位保留尺寸', () => {
    const root = renderRoot('<img src="logo.png" style="width:200px;height:100px" alt="样式尺寸">');
    JJ.enhance(root);
    root.querySelector('img').dispatchEvent(new Event('error'));
    const placeholder = root.querySelector('.img-placeholder');
    expect(placeholder.style.width).toBe('200px');
    expect(placeholder.style.height).toBe('100px');
  });

  it('无尺寸信息时占位自带 16:9 比例与空 alt', () => {
    const root = renderRoot('![](pic.png)');
    JJ.enhance(root);
    root.querySelector('img').dispatchEvent(new Event('error'));
    const placeholder = root.querySelector('.img-placeholder');
    expect(placeholder.style.aspectRatio).toBe('16/9');
    expect(placeholder.dataset.alt).toBe('');
  });

  it('img 正常加载（无 error）不产生占位', () => {
    const root = renderRoot('![图](pic.png)');
    JJ.enhance(root);
    root.querySelector('img').dispatchEvent(new Event('load'));
    expect(root.querySelector('.img-placeholder')).toBeFalsy();
    expect(root.querySelector('img')).toBeTruthy();
  });

  it('enhance 幂等：两次调用只一个占位、error 事件不叠加', () => {
    let calls = 0;
    const root = renderRoot('![徽章](https://img.shields.io/badge/a-b-green)');
    const count = () => {
      calls += 1;
    };
    JJ.enhance(root, { onImageError: count });
    JJ.enhance(root, { onImageError: count });
    root.querySelector('img').dispatchEvent(new Event('error'));
    expect(root.querySelectorAll('.img-placeholder')).toHaveLength(1);
    expect(calls).toBe(1);
    expect(root.querySelector('img')).toBeFalsy();
  });

  it('onImageError 回调收到占位元素与原始图片信息', () => {
    let seen = null;
    const root = renderRoot('![徽章](https://img.shields.io/badge/a-b-green)');
    JJ.enhance(root, {
      onImageError: (placeholder, info) => {
        seen = { placeholder, info };
      },
    });
    root.querySelector('img').dispatchEvent(new Event('error'));
    expect(seen).toBeTruthy();
    expect(seen.placeholder).toBe(root.querySelector('.img-placeholder'));
    expect(seen.info.alt).toBe('徽章');
    expect(seen.info.src).toContain('img.shields.io');
  });
});

describe('标题锚点', () => {
  it('标题锚点 id 与 extractHeadings 一致', () => {
    const md = '# 安装 步骤\n\n## 快速开始';
    const html = JJ.renderMarkdown(md);
    for (const heading of JJ.extractHeadings(md)) {
      expect(html).toContain(`id="${heading.id}"`);
    }
    expect(html).toContain('id="安装-步骤"');
    expect(html).toContain('id="快速开始"');
  });

  it('页内 #anchor 链接指向对应标题 id', () => {
    const md = '# 安装 步骤\n\n[跳到快速开始](#快速开始)\n\n## 快速开始';
    const root = renderRoot(md);
    const link = [...root.querySelectorAll('a')].find((a) => a.textContent === '跳到快速开始');
    expect(link).toBeTruthy();
    // markdown-it 会把链接目标里的中文按 UTF-8 百分号编码，解回原文后应等于标题 id
    const href = link.getAttribute('href');
    expect(href.startsWith('#')).toBe(true);
    expect(decodeURIComponent(href.slice(1))).toBe('快速开始');
    expect(root.querySelector('#快速开始')).toBeTruthy();
  });
});

describe('front matter 属性折叠块', () => {
  it('load 含 front matter 的文档后 #content 顶部生成属性块', () => {
    const root = createRoot();
    const { shell, posted } = mountShell(root);
    shell.onMessage({
      type: 'load',
      payload: loadPayload({
        markdown: '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 正文',
      }),
    });

    const content = root.querySelector('#content');
    const details = content.querySelector('details.frontmatter');
    expect(details).toBeTruthy();
    expect(content.firstElementChild).toBe(details);
    expect(details.querySelector('summary').textContent).toBe('属性');
    // 默认折叠：不带 open
    expect(details.hasAttribute('open')).toBe(false);

    const rows = [...details.querySelectorAll('tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('th').textContent).toBe('title');
    expect(rows[0].querySelector('td').textContent).toBe('测试');
    expect(rows[1].querySelector('th').textContent).toBe('tags');
    expect(rows[1].querySelector('td').textContent).toBe('a、b');

    // 正文照常渲染，renderDone 契约字段不受影响
    expect(content.textContent).toContain('正文');
    const done = posted.find((message) => message.type === 'renderDone');
    expect(done.payload.tocCount).toBe(1);
  });

  it('属性值按纯文本转义（不得拼进 HTML 属性/模板）', () => {
    const root = createRoot();
    const { shell } = mountShell(root);
    shell.onMessage({
      type: 'load',
      payload: loadPayload({
        markdown: '---\nnote: a < b & "c"\n---\n\n正文',
      }),
    });
    const cell = root.querySelector('details.frontmatter td');
    expect(cell.textContent).toBe('a < b & "c"');
    expect(cell.innerHTML).toContain('&lt;');
    expect(cell.innerHTML).toContain('&amp;');
    expect(root.querySelector('details.frontmatter').innerHTML).not.toContain('<script');
  });

  it('无 front matter 的文档不生成属性块（既有 #content 结构不变）', () => {
    const root = createRoot();
    const { shell } = mountShell(root);
    shell.onMessage({ type: 'load', payload: loadPayload() });
    const content = root.querySelector('#content');
    expect(content.querySelector('details.frontmatter')).toBeFalsy();
    expect(content.innerHTML).toContain('标题');
  });

  it('重复 load 不叠加属性块，且每次用本文档的数据（不复用 env）', () => {
    const root = createRoot();
    const { shell } = mountShell(root);
    shell.onMessage({
      type: 'load',
      payload: loadPayload({ markdown: '---\nowner: 甲\n---\n\n正文 甲' }),
    });
    shell.onMessage({
      type: 'load',
      payload: loadPayload({ markdown: '---\nowner: 乙\n---\n\n正文 乙' }),
    });
    const blocks = root.querySelectorAll('#content details.frontmatter');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toContain('乙');
    expect(blocks[0].textContent).not.toContain('甲');
  });

  it('shell 渲染后调用 enhance（图片带 loading/decoding 属性）', () => {
    const root = createRoot();
    const { shell } = mountShell(root);
    shell.onMessage({
      type: 'load',
      payload: loadPayload({ markdown: '![图](pic.png)' }),
    });
    const img = root.querySelector('#content img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });
});
