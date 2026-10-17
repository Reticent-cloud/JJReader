// 修复波 B-I5：DOMPurify 在当前环境 isSupported=false 时 sanitize 会原样返回输入（fail-open）。
// sanitize.js 必须显式失败关闭（返回空串）并只告警一次。
// 通过 __setPurifierFactoryForTest 注入 isSupported=false 的桩实例（生产默认用真实 DOMPurify）。

import { __setPurifierFactoryForTest, sanitizeHtml } from '../../web/src/sanitize.js';

afterEach(() => {
  __setPurifierFactoryForTest(null);
  vi.restoreAllMocks();
});

it('DOMPurify.isSupported=false 时清洗返回空串并告警一次', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  __setPurifierFactoryForTest(() => ({
    isSupported: false,
    addHook() {},
    sanitize: (html) => html,
  }));

  expect(sanitizeHtml('<b>hello</b>')).toBe('');
  expect(sanitizeHtml('<img src=x onerror=alert(1)>')).toBe('');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('DOMPurify');
});

it('恢复真实工厂后清洗继续工作', () => {
  __setPurifierFactoryForTest(() => ({
    isSupported: false,
    addHook() {},
    sanitize: (html) => html,
  }));
  expect(sanitizeHtml('<b>x</b>')).toBe('');

  __setPurifierFactoryForTest(null);
  expect(sanitizeHtml('<b>x</b>')).toContain('<b>x</b>');
});
