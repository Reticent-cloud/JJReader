// 渲染后增强（Task 6）：给代码块复制按钮绑事件、给外链加 target/rel。
// Task 9：图片占位——给每个 img 加 loading="lazy"/decoding="async"，error 时替换为 span.img-placeholder，
// 离线/无 DNS（shields.io 徽章）或本地图片缺失时按原尺寸（或 16:9）占位，不破版、不阻塞首屏。
// 设计约束：绝不抛异常（增强失败不能影响正文显示）、幂等（重复调用不重复绑事件/不重复替换）、
// 不依赖框架（直接操作已解析 DOM）。

/** 已绑过事件的标记：放在按钮上而不是容器上——shell 每次重渲染都会换一批新按钮，容器标记会误伤。 */
const ENHANCED_ATTR = 'data-jj-enhanced';

/** 图片 error 监听只绑一次的标记：写在 img 上（替换成占位后 img 已离开文档，重复 enhance 不会重复处理）。 */
const IMG_GUARD_ATTR = 'data-jj-img-guard';

/** 占位框兜底比例：拿不到宽高时使用（16:9，遵循 spec §5.11「固定 16:9 或按 width/height 的占位框」）。 */
const PLACEHOLDER_ASPECT_RATIO = '16/9';

/** 隐藏 textarea + document.execCommand('copy') 兜底；不可用或返回 false 时返回 false。 */
function copyWithExecCommand(text) {
  const doc = globalThis.document;
  if (!doc || typeof doc.execCommand !== 'function' || !doc.body) {
    return false;
  }
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  doc.body.append(textarea);
  try {
    textarea.select();
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, textarea.value.length);
    }
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    // 兜底用完立刻移除：不能让隐藏 textarea 留在正文里
    textarea.remove();
  }
}

/**
 * 复制文本到剪贴板：优先 navigator.clipboard.writeText（WebView2 安全上下文可用），
 * 失败（权限拒绝/非安全上下文/接口缺失）再走 execCommand 兜底。返回是否成功，绝不抛异常。
 */
async function copyText(text) {
  const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 继续尝试兜底方案
    }
  }
  return copyWithExecCommand(text);
}

/** 给单个复制按钮绑点击事件；已绑过（data-jj-enhanced="1"）直接跳过，保证幂等。 */
function bindCopyButton(btn) {
  if (btn.getAttribute(ENHANCED_ATTR) === '1') {
    return;
  }
  btn.setAttribute(ENHANCED_ATTR, '1');
  btn.addEventListener('click', () => {
    const code = typeof btn.dataset.code === 'string' ? btn.dataset.code : '';
    copyText(code).then((ok) => {
      if (ok) {
        btn.dataset.copied = '1';
        delete btn.dataset.failed;
      } else {
        btn.dataset.failed = '1';
        delete btn.dataset.copied;
      }
    });
  });
}

/**
 * 外链统一新窗口打开并带 noopener noreferrer（C2）：对每个 a[href] 解析，
 * 显式 http:/https:（大小写不敏感）与协议相对地址（//host/...）补 target/rel；
 * 站内锚点、相对链接、javascript:/mailto: 等不改写（javascript: 另由清洗白名单剥除）。
 */
function markExternalLinks(container) {
  for (const link of container.querySelectorAll('a[href]')) {
    const href = (link.getAttribute('href') || '').trim();
    if (href === '') {
      continue;
    }
    // 协议相对地址在 about:blank 文档里无法按 baseURI 解析（WHATWG 对非特殊 scheme 的 // 引用会抛错），
    // 但语义上仍是外部链接：按原串识别，不依赖 URL 解析结果。
    const protocolRelative = href.startsWith('//');
    // 只有显式带 scheme 的绝对地址才算外链：相对链接即使能按 baseURI 解析成 http(s) 也不改写。
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(href);
    let resolved = null;
    try {
      resolved = new URL(href, document.baseURI);
    } catch {
      resolved = null;
    }
    const externalHttp =
      resolved !== null && hasScheme && (resolved.protocol === 'http:' || resolved.protocol === 'https:');
    if (!externalHttp && !protocolRelative) {
      continue;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
}

/**
 * 把宽度/高度规整成 CSS 长度：纯数字按 px（HTML width/height 属性语义），百分比/em 等其它写法原样。
 * @returns {string} 空串表示没有可用尺寸
 */
function cssLength(value) {
  const text = String(value ?? '').trim();
  if (text === '') {
    return '';
  }
  return /^\d+(?:\.\d+)?$/.test(text) ? `${text}px` : text;
}

/** 图片尺寸：内联 style 优先（作者显式样式），其次 width/height 属性；缺失的部分为空串。 */
function imageSize(img) {
  const style = img.style;
  const styleWidth = style ? cssLength(style.width) : '';
  const styleHeight = style ? cssLength(style.height) : '';
  return {
    width: styleWidth || cssLength(img.getAttribute('width')),
    height: styleHeight || cssLength(img.getAttribute('height')),
  };
}

/**
 * 构造占位元素：保留原 alt 文本（data-alt + 可见文本，均按 DOM 文本写入，不拼 HTML），
 * 已知宽高则按原尺寸占位，否则用 16:9 比例撑开，避免版面塌陷。
 */
function buildImagePlaceholder(img) {
  const placeholder = document.createElement('span');
  placeholder.className = 'img-placeholder';
  const alt = img.getAttribute('alt') || '';
  placeholder.dataset.alt = alt;
  placeholder.textContent = alt;
  const { width, height } = imageSize(img);
  if (width) {
    placeholder.style.width = width;
  }
  if (height) {
    placeholder.style.height = height;
  }
  if (!width || !height) {
    placeholder.style.setProperty('aspect-ratio', PLACEHOLDER_ASPECT_RATIO);
  }
  return placeholder;
}

/**
 * 把加载失败的 img 替换为占位元素；img 已不在文档中（被替换过）时直接忽略，保证幂等。
 * onImageError(placeholder, { src, alt }) 为可选回调（宿主/后续任务可据此统计或重试），回调异常不影响正文。
 * @returns {Element|null} 占位元素（未替换时 null）
 */
function replaceWithPlaceholder(img, onImageError) {
  const parent = img.parentNode;
  if (!parent) {
    return null;
  }
  const info = {
    src: img.getAttribute('src') || '',
    alt: img.getAttribute('alt') || '',
  };
  const placeholder = buildImagePlaceholder(img);
  parent.replaceChild(placeholder, img);
  if (typeof onImageError === 'function') {
    try {
      onImageError(placeholder, info);
    } catch {
      // 回调失败不能影响正文：占位已经替换完成，吞掉异常
    }
  }
  return placeholder;
}

/** 给单张图片绑 error 兜底并补 loading/decoding 属性；已绑过（data-jj-img-guard="1"）只补属性，不重复绑定。 */
function guardImage(img, onImageError) {
  if (img.getAttribute(IMG_GUARD_ATTR) !== '1') {
    img.setAttribute(IMG_GUARD_ATTR, '1');
    img.addEventListener(
      'error',
      () => {
        replaceWithPlaceholder(img, onImageError);
      },
      { once: true },
    );
  }
  // 属性设置天然幂等：已有作者指定的值时不覆盖
  if (!img.hasAttribute('loading')) {
    img.setAttribute('loading', 'lazy');
  }
  if (!img.hasAttribute('decoding')) {
    img.setAttribute('decoding', 'async');
  }
}

/**
 * 渲染后增强：代码复制按钮 + 外链属性 + 图片占位兜底。
 * @param {Element|DocumentFragment} container 渲染容器（shell 的 #content）
 * @param {{baseUrl?: string, onImageError?: (placeholder: Element, info: {src: string, alt: string}) => void}} options
 *   baseUrl 保留（相对图片 src 已在渲染期按 baseUrl 改写）；onImageError 在图片失败换占位后回调
 */
export function enhance(container, { baseUrl, onImageError } = {}) {
  void baseUrl; // 相对图片 src 已由引擎渲染期按 baseUrl 改写，这里只需要做失败兜底
  if (!container || typeof container.querySelectorAll !== 'function') {
    return;
  }
  for (const btn of container.querySelectorAll('.code-wrap button.copy')) {
    bindCopyButton(btn);
  }
  // 纯属性设置天然幂等（重复设成同一个值），不需要打标记
  markExternalLinks(container);
  for (const img of container.querySelectorAll('img')) {
    guardImage(img, onImageError);
  }
}
