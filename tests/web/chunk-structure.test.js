// 修复波 B-I2（前端评审）：分块结构保护必须覆盖 markdown-it 的真实语法——
// 无前导 `|` 的 GFM 表格、引用/列表内围栏、HTML 块、以及无效 YAML front matter（不能当惰性块）。
// 每个用例都断言 blocks.join('') === 原文（零丢失）。

function fenceCount(text) {
  return (text.match(/^[\t >-]*`{3,}/gm) ?? []).length;
}

describe('分块结构保护（修复波 B）', () => {
  it('100KB 无前导 | 的 GFM 表格整块不切（每块内表格结构完整）', () => {
    const table =
      '列一 | 列二\n' +
      '--- | ---\n' +
      '甲 | 乙\n'.repeat(9000);
    const { blocks } = JJ.splitBlocks(table, { maxBlockBytes: 512 });

    // 表格是原子结构：即使远超单块预算也整块保留
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startsWith('列一 | 列二')).toBe(true);
    expect(blocks.join('')).toBe(table);
  });

  it('引用块内的围栏代码块整块不切（100KB > 块预算）', () => {
    const fence = '> ```\n' + '> const a = 1;\n'.repeat(7000) + '> ```\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 1024 });

    expect(blocks).toHaveLength(1);
    for (const block of blocks) {
      expect(fenceCount(block) % 2).toBe(0);
    }
    expect(blocks.join('')).toBe(fence);
  });

  it('列表项内的围栏代码块整块不切', () => {
    const fence = '- 列表项\n  ```js\n' + '  const value = 1;\n'.repeat(7000) + '  ```\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 512 });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].endsWith('  ```\n')).toBe(true);
    expect(blocks.join('')).toBe(fence);
  });

  it('嵌套引用 + 列表里的围栏也能识别（最多 3 层 >）', () => {
    const fence = '> - 项目\n>   ~~~\n' + '>   code\n'.repeat(9000) + '>   ~~~\n';
    const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 512 });

    expect(blocks).toHaveLength(1);
    expect(blocks.join('')).toBe(fence);
  });

  it('HTML 块（块级开标签到空行）整块不切', () => {
    const html = '<div class="wrap">\n' + '  <p>row</p>\n'.repeat(7000) + '</div>\n';
    const { blocks } = JJ.splitBlocks(html, { maxBlockBytes: 512 });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].startsWith('<div class="wrap">')).toBe(true);
    expect(blocks.join('')).toBe(html);
  });

  it('HTML 块在空行处正常结束（空行之后可以继续切）', () => {
    const markdown = '<details>\n<summary>s</summary>\n</details>\n\n' + '段落内容。\n'.repeat(2000);
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 512 });

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0].startsWith('<details>')).toBe(true);
    expect(blocks.join('')).toBe(markdown);
  });

  it('无效 YAML front matter 不当作惰性块（首块可继续按预算切）', () => {
    const markdown = '---\n这行不是 YAML，没有冒号\n---\n' + '正文内容。\n'.repeat(2000);
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 512 });

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join('')).toBe(markdown);
  });

  it('有效 YAML front matter 仍是原子块（首块包含完整 front matter）', () => {
    const markdown = '---\ntitle: 示例\ntags: [a, b]\n---\n' + '正文内容。\n'.repeat(2000);
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 512 });

    expect(blocks[0].startsWith('---\ntitle: 示例')).toBe(true);
    expect(blocks[0]).toContain('tags: [a, b]');
    expect(blocks.join('')).toBe(markdown);
  });

  it('表格块中穿插的普通段落仍可切分（不误伤整篇）', () => {
    const markdown =
      'a | b\n--- | ---\n1 | 2\n\n' + '普通段落。\n'.repeat(2000) + '\n' + 'c | d\n--- | ---\n3 | 4\n';
    const { blocks } = JJ.splitBlocks(markdown, { maxBlockBytes: 512 });

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join('')).toBe(markdown);
    // 两个表格各自完整落在某个块里
    expect(blocks.some((block) => block.includes('a | b\n--- | ---\n1 | 2'))).toBe(true);
    expect(blocks.some((block) => block.includes('c | d\n--- | ---\n3 | 4'))).toBe(true);
  });
});
