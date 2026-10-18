// 渲染引擎基础用例（Task 5）：markdown-it 单例、GFM 基础语法、标题 id、图片路径改写、extractHeadings/slugify。
// 只通过 setup.js 装配的 JJ.* 使用 API；T6 的扩展语法（表格/任务清单/脚注/高亮）与 T7 的清洗在各自任务文件里追加。

/** 默认带虚拟主机 baseUrl 渲染（与宿主 load.baseUrl 一致）。 */
const html = (md) => JJ.renderMarkdown(md, { baseUrl: 'https://md.local/' });

describe('GFM 基础语法', () => {
  it.each([
    ['# 一级标题', /<h1[^>]*>一级标题<\/h1>/],
    // 尾部井号闭合序列：CommonMark 要求闭合井号前有空格，故用 '## 二级 ##'
    ['## 二级 ##', /<h2[^>]*>二级<\/h2>/],
    ['**粗** *斜* ~~删~~', /<strong>粗<\/strong>.*<em>斜<\/em>.*<s>删<\/s>/s],
    ['- a\n  - b', /<ul>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/ul>/], // 嵌套列表
    ['1. a\n2. b', /<ol>[\s\S]*<\/ol>/],
    ['[链接](https://example.com)', /<a href="https:\/\/example.com">链接<\/a>/],
    ['https://example.com', /<a href="https:\/\/example.com"/], // linkify 自动链接
    ['![图](img/a.png)', /<img src="https:\/\/md\.local\/img\/a\.png" alt="图"/],
    ['> 引用', /<blockquote>[\s\S]*引用/],
    ['---', /<hr\s*\/?>/],
    ['`code`', /<code>code<\/code>/],
    ['\\*not em\\*', /\*not em\*/], // 反斜杠转义：不能变成 <em>
  ])('%s 渲染正确', (md, re) => {
    expect(html(md)).toMatch(re);
  });

  it('内嵌 HTML 原样透传（清洗留给 Task 7）', () => {
    expect(JJ.renderMarkdown('<b>粗</b>')).toContain('<b>粗</b>');
  });
});

describe('图片相对路径改写', () => {
  it('未给 baseUrl 时相对路径保持原样', () => {
    expect(JJ.renderMarkdown('![图](img/a.png)')).toContain('src="img/a.png"');
  });

  it('绝对地址不随 baseUrl 改写', () => {
    for (const src of ['https://cdn.example.com/a.png', 'data:image/png;base64,AAAA']) {
      expect(html(`![图](${src})`)).toContain(`src="${src}"`);
    }
  });
});

// 语法矩阵补行（测试评审 Important）：Setext 标题、<br>、<img align> 与「不支持（原样文本）」三类。
// 不支持语法按 spec §5.7 最后一行锁定为字面文本，不引入插件、不静默改写。
describe('语法矩阵补充（Setext / 内嵌 HTML / 不支持语法原样文本）', () => {
  it('Setext 标题渲染为 h1/h2', () => {
    expect(html('Setext 一级\n===')).toMatch(/<h1[^>]*>Setext 一级<\/h1>/);
    expect(html('Setext 二级\n---')).toMatch(/<h2[^>]*>Setext 二级<\/h2>/);
  });

  it('<br> 与 <img align="center"> 保留', () => {
    const out = html('第一行<br>第二行\n\n<img src="x.png" align="center">');
    expect(out).toContain('<br>');
    expect(out).toMatch(/<img[^>]*align="center"/);
    expect(out).toContain('src="x.png"');
  });

  it('数学公式按原样文本显示（不渲染、不吞字符）', () => {
    const out = html('行内 $E=mc^2$ 与块级 $$a+b$$');
    expect(out).toContain('$E=mc^2$');
    expect(out).toContain('$$a+b$$');
  });

  it('Mermaid 代码块按普通围栏代码显示原文', () => {
    const out = html('```mermaid\ngraph TD\n  A-->B\n```');
    expect(out).toContain('language-mermaid');
    expect(out).toContain('graph TD');
    expect(out).toContain('A--&gt;B');
  });

  it('定义列表不生成 <dl>，按普通段落原样文本显示', () => {
    const out = html('术语\n: 定义');
    expect(out).toContain('术语');
    expect(out).toContain(': 定义');
    expect(out).not.toContain('<dl>');
  });
});

describe('标题 id 与 extractHeadings', () => {
  it('标题生成稳定 id 且重复标题依次去重', () => {
    const h = JJ.extractHeadings('# 中文 标题\n# 中文 标题');
    expect(h).toHaveLength(2);
    expect(h[0].id).toBe('中文-标题');
    expect(h[1].id).toBe('中文-标题-2');
  });

  it('extractHeadings 返回标题纯文本与层级', () => {
    expect(JJ.extractHeadings('## **粗体** 标题\n\n#### 四级')).toEqual([
      { id: '粗体-标题', text: '粗体 标题', level: 2 },
      { id: '四级', text: '四级', level: 4 },
    ]);
  });

  it('extractHeadings 与 renderMarkdown 的 id 完全一致', () => {
    const markdown = '# 一级\n\n## 二级\n\n## 二级\n\n### **粗体** 标题';
    const headings = JJ.extractHeadings(markdown);
    expect(headings.map((h) => h.id)).toEqual(['一级', '二级', '二级-2', '粗体-标题']);

    const out = JJ.renderMarkdown(markdown);
    for (const heading of headings) {
      expect(out).toContain(`id="${heading.id}"`);
    }
  });

  it('中文/字母/数字保留，标点与符号丢弃，空白转 -', () => {
    expect(JJ.extractHeadings('# 中文 标题， Hello World! 2024')[0].id).toBe(
      '中文-标题-Hello-World-2024',
    );
  });

  it('连续分隔折叠、首尾标点去除', () => {
    expect(JJ.extractHeadings('# ——标题!! ——')[0].id).toBe('标题');
  });

  it('没有标题的文档返回空数组', () => {
    expect(JJ.extractHeadings('只有正文，没有标题。')).toEqual([]);
  });
});

describe('slugify', () => {
  it('连续 - 折叠且去掉首尾 -', () => {
    expect(JJ.slugify('  ——标题!!  ')).toBe('标题');
  });

  it('usedIds 里的重复 id 依次加 -2、-3', () => {
    const used = new Set();
    expect(JJ.slugify('标题', used)).toBe('标题');
    expect(JJ.slugify('标题', used)).toBe('标题-2');
    expect(JJ.slugify('标题', used)).toBe('标题-3');
  });

  it('不传 usedIds 时只做 slug 化、不登记', () => {
    expect(JJ.slugify('标题')).toBe('标题');
    expect(JJ.slugify('标题')).toBe('标题');
  });
});
