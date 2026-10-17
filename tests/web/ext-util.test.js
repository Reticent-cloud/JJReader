// 修复波 B：splitBracketed 的 O(n²) DoS 回归 + 语义保持。
// 旧实现对每个 `[[` 都从当前位置扫到文档末尾找 `]]`；`'[[x'.repeat(5000)` 这类无闭合输入会平方级退化。
// 新实现按源码缓存换行/闭合位置（一次 O(n) 扫描 + 二分），并限制单行 label ≤ 2000 字符。

import { splitBracketed } from '../../web/src/ext/util.js';

describe('splitBracketed 语义', () => {
  it('解析目标与别名（同行、最近闭合）', () => {
    expect(splitBracketed('前 [[目标|别名]] 后', 2)).toEqual({ target: '目标', alias: '别名', end: 11 });
  });

  it('没有别名时 alias 为空串', () => {
    expect(splitBracketed('[[a]]', 0)).toEqual({ target: 'a', alias: '', end: 5 });
  });

  it('跨行的 ]] 不算（笔记体语法不跨行）', () => {
    expect(splitBracketed('[[a\nb]]', 0)).toBeNull();
  });

  it('maxPos 收窄时闭合越界不匹配', () => {
    expect(splitBracketed('[[a]] rest', 0, 4)).toBeNull();
    expect(splitBracketed('[[a]] rest', 0, 5)).toEqual({ target: 'a', alias: '', end: 5 });
  });

  it('超长 label（> 2000 字符）直接判为不匹配', () => {
    const src = '[[' + 'x'.repeat(2500) + ']]';
    expect(splitBracketed(src, 0)).toBeNull();
  });

  it('非 [[ 起始/非法参数返回 null', () => {
    expect(splitBracketed('[x', 0)).toBeNull();
    expect(splitBracketed('[[x]]', -1)).toBeNull();
    expect(splitBracketed(null, 0)).toBeNull();
  });
});

describe('splitBracketed DoS 回归', () => {
  it("'[[x'.repeat(5000) 的整篇渲染不超过 100ms（宽松阈值防 flaky）", () => {
    const source = '[[x'.repeat(5000);

    const started = Date.now();
    JJ.renderMarkdown(source);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
  });
});
