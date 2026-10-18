// 主题三态（Task 10）：light / dark / system → <html data-theme="light|dark">。
// system 时用 matchMedia('(prefers-color-scheme: dark)') 解析并订阅 change（实时跟随系统切换）；
// 切到固定主题时解除上一次订阅，保证全局最多只有一个系统主题监听。
// 不依赖真实 matchMedia：不存在时（jsdom / 老旧环境）按浅色解析，绝不抛异常。

/** 主题三态的合法值。 */
export const THEMES = ['light', 'dark', 'system'];

/** 系统深色查询串（applyTheme 与测试共同口径）。 */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** 非法/缺省主题一律归一为 system（与 settings.json 默认值一致）。 */
export function normalizeTheme(theme) {
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

/** 三态循环：light → dark → system → light（主题按钮点击用）。 */
export function nextTheme(theme) {
  const current = normalizeTheme(theme);
  if (current === 'light') {
    return 'dark';
  }
  if (current === 'dark') {
    return 'system';
  }
  return 'light';
}

/** 上一次 system 订阅的清理函数；模块级唯一，避免重复 applyTheme 叠加监听。 */
let cleanupSystemListener = null;

function setThemeAttribute(resolved) {
  const doc = globalThis.document;
  if (doc && doc.documentElement) {
    doc.documentElement.setAttribute('data-theme', resolved);
  }
  return resolved;
}

/** 取 matchMedia：优先调用方注入（测试用），其次浏览器 window.matchMedia；都没有返回 null。 */
function resolveMatchMedia(options) {
  const injected = options && options.matchMedia;
  if (typeof injected === 'function') {
    return (query) => injected(query);
  }
  const win = globalThis.window;
  if (win && typeof win.matchMedia === 'function') {
    return (query) => win.matchMedia(query);
  }
  return null;
}

/** 订阅 change：优先现代 addEventListener，退回旧版 addListener；返回移除函数（无法订阅时 null）。 */
function listenChange(mediaQueryList, handler) {
  if (mediaQueryList && typeof mediaQueryList.addEventListener === 'function') {
    mediaQueryList.addEventListener('change', handler);
    return () => mediaQueryList.removeEventListener('change', handler);
  }
  if (mediaQueryList && typeof mediaQueryList.addListener === 'function') {
    mediaQueryList.addListener(handler);
    return () => mediaQueryList.removeListener(handler);
  }
  return null;
}

/**
 * 应用主题并返回解析后的实际配色（light|dark）。
 * @param {'light'|'dark'|'system'|string} theme 主题（非法值按 system）
 * @param {{matchMedia?: (query: string) => MediaQueryList}} [options] matchMedia 注入（测试/兼容用）
 * @returns {'light'|'dark'}
 */
export function applyTheme(theme, options = {}) {
  const requested = normalizeTheme(theme);

  // 每次调用先解除旧的 system 订阅：固定主题不再跟随，system 只保留最新一条监听。
  if (cleanupSystemListener) {
    cleanupSystemListener();
    cleanupSystemListener = null;
  }

  if (requested !== 'system') {
    return setThemeAttribute(requested);
  }

  const matchMedia = resolveMatchMedia(options);
  const mediaQueryList = matchMedia ? matchMedia(DARK_SCHEME_QUERY) : null;
  const resolve = () => (mediaQueryList && mediaQueryList.matches ? 'dark' : 'light');
  const resolved = setThemeAttribute(resolve());
  if (!mediaQueryList) {
    return resolved;
  }

  const cleanup = listenChange(mediaQueryList, () => {
    setThemeAttribute(mediaQueryList.matches ? 'dark' : 'light');
  });
  cleanupSystemListener = cleanup;
  return resolved;
}
