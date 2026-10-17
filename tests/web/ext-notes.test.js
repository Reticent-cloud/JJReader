// 笔记体扩展语法用例（Task 8）：front matter、wikilink、附件、==高亮==、%%注释%% 与安全边界。
// 职责边界：wikilink/附件的点击寻文件是 T13 宿主 NoteResolver 的事，这里只断言渲染出的
// data-target / 虚拟主机 URL；附件别名（brief 未定）按 Controller 口径：图片别名作 alt、非图片别名作链接文本。
// front matter 的解析口径（brief 未定处）：未闭合/块内行不是 `key: value` → { data:{}, body:原文 }，正文不被吞。

const BASE_URL = 'https://md.local/';

/** 默认带虚拟主机 baseUrl 渲染（与宿主 load.baseUrl 一致）。 */
const html = (md) => JJ.renderMarkdown(md, { baseUrl: BASE_URL });

/** 渲染到独立 div（不挂 body）后做 DOM 断言，用于确认属性没有变成可执行元素/事件。 */
function renderRoot(markdown) {
  const root = document.createElement('div');
  root.innerHTML = JJ.renderMarkdown(markdown, { baseUrl: BASE_URL });
  return root;
}

describe('front matter', () => {
  it('从正文剥离并提取为数据', () => {
    const md = '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 正文';
    const out = html(md);
    expect(out).not.toContain('title: 测试');
    expect(out).not.toContain('<hr');
    expect(out).toContain('正文');
    expect(JJ.extractFrontmatter(md).data.title).toBe('测试');
  });

  it('无 front matter 时 data 为空、body 为原文', () => {
    const md = '# 标题\n\n正文';
    expect(JJ.extractFrontmatter(md)).toEqual({ data: {}, body: md });
  });

  it('数组值解析为字符串数组（元素去引号）', () => {
    const { data } = JJ.extractFrontmatter('---\ntags: [a, "b c", \'d\']\n---\n正文');
    expect(data.tags).toEqual(['a', 'b c', 'd']);
  });

  it('带引号的标量去引号', () => {
    const { data } = JJ.extractFrontmatter('---\ntitle: "带 空格"\nname: \'单引号\'\n---\n');
    expect(data.title).toBe('带 空格');
    expect(data.name).toBe('单引号');
  });

  it('true/false 转布尔，数字保持字符串', () => {
    const { data } = JJ.extractFrontmatter(
      '---\ndraft: true\nstarred: false\ncount: 42\nversion: 1.10\n---\n',
    );
    expect(data).toEqual({ draft: true, starred: false, count: '42', version: '1.10' });
  });

  it('重复 key 后值覆盖', () => {
    expect(JJ.extractFrontmatter('---\ntitle: a\ntitle: b\n---\n').data.title).toBe('b');
  });

  it('未闭合 --- 视为无效：data 空、body 原文、正文不被吞', () => {
    const md = '---\ntitle: 测试\n\n# 正文';
    expect(JJ.extractFrontmatter(md)).toEqual({ data: {}, body: md });
    const out = html(md);
    expect(out).toContain('title: 测试');
    expect(out).toContain('正文');
  });

  it('块内有非 key: value 行时视为无效，body 原文', () => {
    const md = '---\n这不是键值行\n---\n正文';
    expect(JJ.extractFrontmatter(md)).toEqual({ data: {}, body: md });
    expect(html(md)).toContain('这不是键值行');
  });

  it('CRLF 换行同样解析（Windows 文档）', () => {
    const md = '---\r\ntitle: 测试\r\n---\r\n\r\n# 正文';
    expect(JJ.extractFrontmatter(md).data).toEqual({ title: '测试' });
    expect(html(md)).toContain('<h1');
    expect(html(md)).not.toContain('title: 测试');
  });

  it('结尾无换行的 front matter 也能解析', () => {
    expect(JJ.extractFrontmatter('---\ntitle: x\n---')).toEqual({ data: { title: 'x' }, body: '' });
  });

  it('非文档开头的 --- 块不当 front matter', () => {
    const md = '正文\n\n---\ntitle: x\n---\n';
    expect(JJ.extractFrontmatter(md).data).toEqual({});
  });

  it('renderMarkdown 把解析结果写入 env.frontmatter（与 extractFrontmatter 一致）', () => {
    const md = '---\nowner: 鲸鲸\n---\n\n正文';
    const env = { baseUrl: BASE_URL };
    JJ.renderMarkdown(md, env);
    expect(env.frontmatter).toEqual(JJ.extractFrontmatter(md).data);
    expect(env.frontmatter).toEqual({ owner: '鲸鲸' });
  });

  it('无 front matter 时 env.frontmatter 为空对象', () => {
    const env = {};
    JJ.renderMarkdown('正文', env);
    expect(env.frontmatter).toEqual({});
  });

  it('env 已带 frontmatter 时不被覆盖', () => {
    const env = { frontmatter: { custom: 1 } };
    JJ.renderMarkdown('---\ntitle: t\n---\n正文', env);
    expect(env.frontmatter).toEqual({ custom: 1 });
  });
});

describe('wikilink [[...]]', () => {
  it('生成 class/href/data-target 与文本', () => {
    const out = html('见 [[笔记甲]]');
    expect(out).toContain('class="wikilink"');
    expect(out).toContain('href="#"');
    expect(out).toContain('data-target="笔记甲"');
    expect(out).toContain('>笔记甲</a>');
  });

  it('别名渲染为链接文本，data-target 仍是目标', () => {
    const out = html('见 [[笔记甲|小甲]]');
    expect(out).toContain('data-target="笔记甲"');
    expect(out).toContain('>小甲</a>');
    expect(out).not.toContain('>笔记甲</a>');
  });

  it('一行多个链接 + 中文别名', () => {
    const out = html('先 [[甲]] 再 [[乙|乙的别名]]');
    expect(out).toContain('data-target="甲"');
    expect(out).toContain('data-target="乙"');
    expect(out).toContain('>乙的别名</a>');
  });

  it('目标/别名去首尾空格', () => {
    const out = html('[[ 笔记甲 | 小甲 ]]');
    expect(out).toContain('data-target="笔记甲"');
    expect(out).toContain('>小甲</a>');
  });

  it('空目标原样文本', () => {
    const out = html('[[ ]]');
    expect(out).not.toContain('wikilink');
    expect(out).toContain('[[ ]]');
  });

  it('未闭合的 [[ 原样文本', () => {
    expect(html('[[未闭合')).not.toContain('wikilink');
  });

  it('行内代码内不转换', () => {
    expect(html('`[[笔记甲]]`')).not.toContain('wikilink');
  });

  it('fenced code 内不转换', () => {
    const out = html('```\n[[笔记甲]]\n```');
    expect(out).not.toContain('wikilink');
    expect(out).toContain('[[笔记甲]]');
  });

  it('目标含引号/尖括号不注入属性或元素', () => {
    const root = renderRoot('[[<img src=x onerror=alert(1)>]]');
    const link = root.querySelector('a.wikilink');
    expect(link).toBeTruthy();
    expect(root.querySelector('img')).toBeNull();
    expect(link.hasAttribute('onerror')).toBe(false);
    expect(link.hasAttribute('src')).toBe(false);
    expect(link.getAttribute('data-target')).toBe('<img src=x onerror=alert(1)>');
  });

  it('外链文本里的 [[x]] 不破坏外链解析（HTML 不允许 a 嵌 a）', () => {
    const out = html('[see [[b]] here](https://example.com)');
    expect(out).toContain('<a href="https://example.com">');
    expect(out).not.toContain('data-target="b"');
  });
});

describe('附件 ![[...]]', () => {
  it('图片附件解析为虚拟主机地址', () => {
    expect(html('![[图 1.png]]')).toContain('src="https://md.local/%E5%9B%BE%201.png"');
  });

  it('图片附件带 attachment 类与 alt=文件名', () => {
    const out = html('![[图.png]]');
    expect(out).toContain('class="attachment"');
    expect(out).toMatch(/alt="图\.png"/);
  });

  it('图片附件别名作为 alt（brief 未定，实现口径）', () => {
    const out = html('![[图.png|说明文字]]');
    expect(out).toMatch(/alt="说明文字"/);
    expect(out).toContain('https://md.local/%E5%9B%BE.png');
  });

  it('图片扩展名大小写不敏感', () => {
    expect(html('![[A.JPG]]')).toMatch(/<img[^>]*class="attachment"/);
    expect(html('![[b.Avif]]')).toContain('<img');
    expect(html('![[c.webp]]')).toContain('<img');
  });

  it('非图片附件输出带 data-target 的链接', () => {
    const out = html('![[说明.md]]');
    expect(out).toContain('class="attachment"');
    expect(out).toContain('data-target="说明.md"');
    expect(out).toContain('>说明.md</a>');
  });

  it('非图片附件别名作为链接文本', () => {
    const out = html('![[说明.md|看这里]]');
    expect(out).toContain('data-target="说明.md"');
    expect(out).toContain('>看这里</a>');
  });

  it('未给 baseUrl 时图片 src 保持相对路径', () => {
    expect(JJ.renderMarkdown('![[图.png]]')).toContain('src="图.png"');
  });

  it('空目标原样文本', () => {
    const out = html('![[ ]]');
    expect(out).not.toContain('class="attachment"');
    expect(out).toContain('![[ ]]');
  });

  it('行内代码内不转换', () => {
    const out = html('`![[图.png]]`');
    expect(out).not.toContain('<img');
    expect(out).toContain('![[图.png]]');
  });

  it('fenced code 内不转换', () => {
    expect(html('```\n![[图.png]]\n```')).not.toContain('<img');
  });

  it('附件目标不能注入事件属性', () => {
    const root = renderRoot('![[x" onmouseover="alert(1).md]]');
    const link = root.querySelector('a.attachment');
    expect(link).toBeTruthy();
    expect(link.hasAttribute('onmouseover')).toBe(false);
    expect(link.getAttribute('data-target')).toBe('x" onmouseover="alert(1).md');
  });
});

describe('==高亮==', () => {
  it('渲染 mark', () => {
    expect(html('这是 ==重点==')).toContain('<mark>重点</mark>');
  });

  it('同一行多个高亮', () => {
    const out = html('==甲== 与 ==乙==');
    expect(out).toContain('<mark>甲</mark>');
    expect(out).toContain('<mark>乙</mark>');
  });

  it('高亮内可嵌套强调', () => {
    expect(html('==**重点**==')).toContain('<mark><strong>重点</strong></mark>');
  });

  it('空的 ==== 原样文本', () => {
    const out = html('====');
    expect(out).not.toContain('<mark>');
    expect(out).toContain('====');
  });

  it('未闭合 == 原样文本', () => {
    expect(html('==未闭合')).not.toContain('<mark>');
  });

  it('不跨行', () => {
    expect(html('==第一行\n第二行==')).not.toContain('<mark>');
  });

  it('行内代码内不转换', () => {
    expect(html('`==不是高亮==`')).not.toContain('<mark>');
  });

  it('fenced code 内不转换', () => {
    expect(html('```\n==不是高亮==\n```')).not.toContain('<mark>');
  });

  it('标题文本参与 id 计算（高亮不丢字）', () => {
    expect(JJ.extractHeadings('# ==标题==')[0]).toEqual({ id: '标题', text: '标题', level: 1 });
  });
});

describe('%%注释%%', () => {
  it('行内注释不渲染', () => {
    expect(html('可见 %%隐藏%% 可见')).not.toContain('隐藏');
  });

  it('独占整行注释不残留空段落', () => {
    const out = html('%%整行注释%%');
    expect(out).not.toContain('整行注释');
    expect(out).not.toContain('<p>');
  });

  it('独占行块注释整块删除', () => {
    const out = html('前文\n\n%%\n块内注释\n第二行注释\n%%\n\n后文');
    expect(out).not.toContain('块内注释');
    expect(out).not.toContain('第二行注释');
    expect(out).toContain('前文');
    expect(out).toContain('后文');
  });

  it('未闭合的块注释不吞正文', () => {
    const out = html('前文\n\n%%\n未闭合块\n\n后文');
    expect(out).toContain('%%');
    expect(out).toContain('未闭合块');
    expect(out).toContain('后文');
  });

  it('100%% 不被当成注释起点', () => {
    expect(html('完成度 100%%')).toContain('100%%');
  });

  it('100%% 之后仍有注释时不吞中间文字', () => {
    const out = html('完成度 100%% 的说明 %%隐藏%% 结尾');
    expect(out).toContain('100%% 的说明');
    expect(out).not.toContain('隐藏');
    expect(out).toContain('结尾');
  });

  it('注释内容里的单个 % 不提前结束', () => {
    const out = html('可见 %%进度 50% 完成%% 结束');
    expect(out).not.toContain('进度');
    expect(out).toContain('可见');
    expect(out).toContain('结束');
  });

  it('不跨行（行内注释跨行不匹配）', () => {
    const out = html('%%开头\n结尾%%');
    expect(out).toContain('%%开头');
    expect(out).toContain('结尾%%');
  });

  it('行内代码内 %% 原样保留', () => {
    expect(html('`%%x%%`')).toContain('%%x%%');
  });

  it('fenced code 内 %% 原样保留', () => {
    const out = html('```\n%%x%%\n```');
    expect(out).toContain('%%x%%');
  });
});

describe('安全边界', () => {
  it('整篇含 <script> 时仍被清洗', () => {
    const out = html('# 标题\n\n<script>alert(1)</script>\n\n正文');
    expect(out).not.toContain('<script');
    expect(out).toContain('正文');
  });

  it('高亮内的原始 HTML 同样经清洗', () => {
    const out = html('==<script>alert(1)</script>==');
    expect(out).not.toContain('<script');
  });

  it('附件图片的非安全地址被清洗掉（不进入 src / 不产生活标签）', () => {
    const out = html('![[javascript:alert(1).png]]');
    expect(out).not.toContain('src="javascript:');
    expect(out).not.toContain('<script');
  });
});
