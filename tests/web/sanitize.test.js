// HTML 清洗用例（Task 7）：DOMPurify 白名单 + 协议白名单 + style 过滤 + renderMarkdown 出口统一清洗。
// 安全模型（spec §4.5.6）：Markdown 内嵌 HTML 一律经 sanitizeHtml 后才进 DOM。
// 既有功能回归（任务清单 input / 脚注锚点 / 表格对齐 / 复制按钮 data-code / 外链）在「跨任务放行」与
// 「renderMarkdown 出口」两节里守护：清洗不能把后续任务依赖的结构剥掉。
// 测试评审 must-fix：补充大小写/实体/空白/协议相对/svg+xml 混淆变体，并直接单测 isSafeUrl 与空白归一化。

import { isSafeUrl, URL_WHITESPACE_RE } from '../../web/src/sanitize.js';

const BASE_URL = 'https://md.local/';

const mounted = [];

/** 默认带虚拟主机 baseUrl 渲染（与宿主 load.baseUrl 一致）。 */
const render = (md) => JJ.renderMarkdown(md, { baseUrl: BASE_URL });

/** 解析成独立 div（只用于查询结构与属性，不挂到 body，避免跨用例污染）。 */
function parse(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.innerHTML = '';
});

describe('危险内容移除', () => {
  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<iframe src="x"></iframe>', 'iframe'],
    ['<object data="x"></object>', 'object'],
    ['<embed src="x">', 'embed'],
    ['<form action="x"><input name="q"></form>', 'form'],
    ['<textarea>x</textarea>', 'textarea'],
    ['<style>body{color:red}</style>', 'style'],
    ['<link rel="stylesheet" href="x.css">', 'link'],
    ['<meta http-equiv="refresh" content="0;url=x">', 'meta'],
    ['<base href="https://evil.example/">', 'base'],
    ['<div onclick="evil()">t</div>', 'onclick'],
    ['<img src="x" onerror="alert(1)">', 'onerror'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<a href="vbscript:msgbox(1)">x</a>', 'vbscript:'],
    ['<img src="file:///c:/secret.png">', 'file:'],
    ['<a href="data:text/html,<b>x</b>">x</a>', 'data:text/html'],
  ])('移除 %s', (input, forbidden) => {
    expect(JJ.sanitizeHtml(input)).not.toContain(forbidden);
  });
});

describe('安全结构保留', () => {
  it('details/open、summary、kbd、sub、align、style 颜色保留，position 剥离', () => {
    const out = JJ.sanitizeHtml(
      '<details open><summary>标题</summary><p align="center"><kbd>Ctrl</kbd><sub>2</sub></p></details><span style="color:red;position:fixed">x</span>',
    );
    // DOMPurify 重新序列化时布尔属性写成 open=""，语义仍是「details 带 open」
    expect(out).toMatch(/<details[^>]*\bopen\b/);
    expect(out).toContain('<summary>标题</summary>');
    expect(out).toContain('<kbd>Ctrl</kbd>');
    expect(out).toContain('<sub>2</sub>');
    expect(out).toContain('align="center"');
    expect(out).toContain('color:red');
    expect(out).not.toContain('position:fixed');
  });

  it('常见良性内嵌 HTML 标签保留', () => {
    const out = JJ.sanitizeHtml(
      '<center><mark>m</mark><small>s</small><abbr>a</abbr><del>d</del><s>s</s><u>u</u><font>f</font></center>',
    );
    for (const tag of ['center', 'mark', 'small', 'abbr', 'del', 's', 'u', 'font']) {
      expect(out).toContain(`<${tag}>`);
    }
  });

  it('标题 id 与 href="#fn1" 锚点保留', () => {
    const out = JJ.sanitizeHtml('<h2 id="标题">t</h2><a href="#fn1" id="fnref1">[1]</a>');
    expect(out).toContain('<h2 id="标题">t</h2>');
    expect(out).toContain('href="#fn1"');
    expect(out).toContain('id="fnref1"');
  });
});

describe('协议白名单', () => {
  it('data:image 默认保留', () => {
    expect(JJ.sanitizeHtml('<img src="data:image/png;base64,AAA">')).toContain('data:image/png');
  });

  it('allowDataImages=false 时 data:image 也移除', () => {
    const out = JJ.sanitizeHtml('<img src="data:image/png;base64,AAA">', { allowDataImages: false });
    expect(out).not.toContain('data:image');
  });

  it('data:image 以外的 data: URI 挂在 img 上也移除（DOM 解析路径不放行）', () => {
    expect(JJ.sanitizeHtml('<img src="data:text/html,<b>x</b>">')).not.toContain('data:text/html');
  });

  it('保留脚注锚点、相对链接、绝对图片地址、mailto/tel', () => {
    const out = JJ.sanitizeHtml(
      '<a href="#fn1">[1]</a><a href="img/a.png">相对</a><img src="https://md.local/img/a.png"><a href="mailto:a@b.c">m</a><a href="tel:123">t</a>',
    );
    expect(out).toContain('href="#fn1"');
    expect(out).toContain('href="img/a.png"');
    expect(out).toContain('src="https://md.local/img/a.png"');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('href="tel:123"');
  });

  it('保留 /x、../x 形式的相对地址', () => {
    const out = JJ.sanitizeHtml('<a href="/x">根</a><img src="../x.png">');
    expect(out).toContain('href="/x"');
    expect(out).toContain('src="../x.png"');
  });

  it('混淆变体 表驱动：危险协议/表达式大小写与空白变形都被移除', () => {
    const cases = [
      ['<a href="JaVaScRiPt:alert(1)">x</a>', /javascript:/i],
      ['<a href="java&#x09;script:alert(1)">x</a>', /javascript:/i],
      ['<a href="java&#x0A;script:alert(1)">x</a>', /javascript:/i],
      ['<a href="java\tscript:alert(1)">x</a>', /javascript:/i],
      ['<a href="java\u0000script:alert(1)">x</a>', /javascript:/i],
      ['<span style="EXPRESSION(alert(1));color:red">x</span>', /expression/i],
      ['<span style="BACKGROUND:URL(javascript:alert(1))">x</span>', /javascript:/i],
      ['<a href="vb&#x53;cript:msgbox(1)">x</a>', /vbscript:/i],
    ];
    for (const [input, forbidden] of cases) {
      expect(JJ.sanitizeHtml(input), input).not.toMatch(forbidden);
    }
  });

  it('协议相对地址 //host/x 按相对 URL 放行（外链拦截由宿主 NavigationStarting 负责）', () => {
    const out = JJ.sanitizeHtml('<a href="//host/x">x</a>');
    expect(out).toContain('href="//host/x"');
    expect(isSafeUrl('//host/x', true)).toBe(true);
  });

  it('href 前导空白：协议校验按去空白后的值判断，地址本身不被误杀', () => {
    const out = JJ.sanitizeHtml('<a href=" https://x.example/a">x</a>');
    const link = parse(out).querySelector('a');
    expect(link).toBeTruthy();
    expect((link.getAttribute('href') ?? '').trim()).toBe('https://x.example/a');
    expect(isSafeUrl(' https://x.example/a', true)).toBe(true);
  });

  it('data:image/svg+xml 按安全裁定显式允许；allowDataImages=false 时失败关闭', () => {
    // 裁定：<img src="data:image/svg+xml,..."> 在 img 上下文不执行脚本，保留（与 data:image/png 同口径）。
    expect(JJ.sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">')).toContain(
      'data:image/svg+xml',
    );
    expect(
      JJ.sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">', { allowDataImages: false }),
    ).not.toContain('data:image');
  });
});

describe('isSafeUrl / URL_WHITESPACE_RE 直接单测', () => {
  it.each([
    ['https://x.example/a', true],
    ['HTTP://X.EXAMPLE', true],
    ['mailto:a@b.c', true],
    ['tel:123', true],
    ['/x', true],
    ['../x', true],
    ['//host/x', true],
    ['#fn1', true],
    ['', true],
    ['data:image/png;base64,AAAA', true],
    ['data:image/svg+xml,<svg></svg>', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['java\tscript:alert(1)', false],
    ['java\u0000script:alert(1)', false],
    ['vbscript:msgbox(1)', false],
    ['file:///c:/secret.png', false],
    ['data:text/html,<b>x</b>', false],
    ['ftp://x.example', false],
  ])('isSafeUrl(%j) → %s', (value, expected) => {
    expect(isSafeUrl(value, true)).toBe(expected);
  });

  it('allowDataImages 只影响 data:image，其余判定不变', () => {
    expect(isSafeUrl('data:image/png;base64,AAAA', false)).toBe(false);
    expect(isSafeUrl('https://x', false)).toBe(true);
    expect(isSafeUrl('javascript:x', false)).toBe(false);
  });

  it('URL_WHITESPACE_RE 覆盖 HTML 属性空白归一化的字符集', () => {
    const raw = 'a\tb\nc\u0000d\u00a0e\u1680f\u180Eg\u2000h\u2029i\u205Fj\u3000k';
    expect(raw.replace(URL_WHITESPACE_RE, '')).toBe('abcdefghijk');
    // U+FEFF 不在归一化集合内：不会把「java<U+FEFF>script:」拼成 javascript:（按相对地址处理）
    expect(isSafeUrl('java\uFEFFscript:x', true)).toBe(true);
  });
});

describe('style 过滤', () => {
  it('表格对齐 style 原样保留（不重排、不追加分号）', () => {
    const out = JJ.sanitizeHtml(
      '<table><thead><tr><th style="text-align:center">a</th></tr></thead></table>',
    );
    expect(out).toContain('style="text-align:center"');
  });

  it('behavior 剥离，color 保留', () => {
    const out = JJ.sanitizeHtml('<span style="behavior:url(x);color:red">x</span>');
    expect(out).toContain('color:red');
    expect(out).not.toContain('behavior');
  });

  it('expression() 剥离，其它白名单声明保留', () => {
    const out = JJ.sanitizeHtml('<span style="width:expression(alert(1));font-size:12px">x</span>');
    expect(out).not.toContain('expression');
    expect(out).toContain('font-size:12px');
  });

  it('position/display 等非白名单声明全部剥离时连 style 属性一起删', () => {
    const out = JJ.sanitizeHtml('<span style="position:fixed;display:none">x</span>');
    expect(out).not.toContain('style=');
  });

  it('白名单内的多项声明保留', () => {
    const out = JJ.sanitizeHtml('<span style="text-align:right;font-weight:bold;color:red">x</span>');
    expect(out).toContain('text-align:right');
    expect(out).toContain('font-weight:bold');
    expect(out).toContain('color:red');
  });
});

describe('跨任务放行（后续任务依赖的结构/属性）', () => {
  it('复制按钮与 data-code 保留', () => {
    expect(
      JJ.sanitizeHtml('<button class="copy" type="button" data-code="x">复制</button>'),
    ).toContain('<button class="copy" type="button" data-code="x">复制</button>');
  });

  it('[TOC] 的 nav/ol/li 与 data-level 保留', () => {
    const out = JJ.sanitizeHtml('<nav class="toc-inline"><ol><li data-level="2">x</li></ol></nav>');
    expect(out).toContain('<nav class="toc-inline">');
    expect(out).toContain('data-level="2"');
  });

  it('笔记锚点 data-target 保留', () => {
    expect(JJ.sanitizeHtml('<a data-target="笔记" href="#x">x</a>')).toContain('data-target="笔记"');
  });

  it('事件处理属性与未放行 data-* 一律剥离', () => {
    const out = JJ.sanitizeHtml('<span onclick="evil()" data-foo="1">x</span>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('data-foo');
    expect(out).toContain('<span>x</span>');
  });

  it('任务清单 checkbox 的 type/disabled/checked 保留', () => {
    const out = JJ.sanitizeHtml('<input type="checkbox" disabled checked class="task-list-item">');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('disabled');
    expect(out).toContain('checked');
    expect(out).toContain('task-list-item');
  });

  it('脚注 section/sup/backref 结构保留', () => {
    const out = JJ.sanitizeHtml(
      '<section class="footnotes"><ol><li id="fn1"><p>注解 <a href="#fnref1" class="footnote-backref">↩</a></p></li></ol></section>' +
        '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>',
    );
    expect(out).toContain('<section class="footnotes">');
    expect(out).toContain('<sup class="footnote-ref">');
    expect(out).toContain('footnote-backref');
  });
});

describe('异常输入', () => {
  it.each([[null], [undefined], [123], [{}], [true], [[]]])(
    '非字符串输入 %s 返回空串且不抛异常',
    (input) => {
      expect(() => JJ.sanitizeHtml(input)).not.toThrow();
      expect(JJ.sanitizeHtml(input)).toBe('');
    },
  );
});

describe('renderMarkdown 出口统一清洗', () => {
  it('内嵌 onerror 被剥、img 本体保留', () => {
    const out = render('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<img');
  });

  it('内嵌 script 被剥', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('<script');
  });

  it('内嵌 iframe/onclick/javascript: 链接被剥', () => {
    const out = render(
      '<iframe src="x"></iframe>\n\n<div onclick="evil()">t</div>\n\n<a href="javascript:alert(1)">点我</a>',
    );
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('点我');
  });

  it('图片相对路径改写不受清洗影响', () => {
    expect(render('![图](img/a.png)')).toContain('src="https://md.local/img/a.png"');
  });

  it('代码块 data-code 清洗后仍能原样还原（含冒号/尖括号/引号/结尾换行）', () => {
    const code = 'key: value\n<a href="x">A & B</a>\nlet s = \'q\';';
    const container = parse(render(`\`\`\`html\n${code}\n\`\`\``));
    const btn = container.querySelector('button.copy');
    expect(btn).toBeTruthy();
    expect(btn.dataset.code).toBe(`${code}\n`);
    // 属性值不能漏出元素
    expect(container.querySelector('a')).toBeNull();
  });

  it('表格对齐/任务清单/脚注在清洗后仍完整', () => {
    const out = render(
      '| a | b |\n|:--:|--:|\n| 1 | 2 |\n\n- [x] 已做\n\n正文[^1]\n\n[^1]: 注解内容',
    );
    expect(out).toMatch(/<th[^>]*style="text-align:center"[^>]*>a<\/th>/);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked');
    expect(out).toContain('task-list-item');
    expect(out).toContain('footnote-backref');
  });
});

describe('shell 集成', () => {
  it('load 含脚本/onerror 的 markdown 后 #content 无 script 元素、无 onerror，renderDone 照发', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const posted = [];
    const shell = JJ.mountShell({
      root,
      post: (type, payload) => posted.push({ type, payload }),
    });
    mounted.push(shell);

    shell.onMessage({
      type: 'load',
      payload: {
        path: 'evil.md',
        key: 'k',
        baseUrl: BASE_URL,
        markdown: '# 标题\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
        settings: {},
        position: null,
      },
    });

    const content = root.querySelector('#content');
    expect(content).toBeTruthy();
    expect(content.querySelector('script')).toBeNull();
    expect(content.innerHTML).not.toContain('onerror');
    expect(content.textContent).toContain('标题');

    const done = posted.find((m) => m.type === 'renderDone');
    expect(done).toBeTruthy();
    expect(done.payload.path).toBe('evil.md');
  });
});
