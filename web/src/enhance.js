// 渲染后增强（Task 6）：给代码块复制按钮绑事件、给外链加 target/rel。
// 设计约束：绝不抛异常（增强失败不能影响正文显示）、幂等（重复调用不重复绑事件）、
// 不依赖框架（直接操作已解析 DOM）。图片加载失败兜底（onImageError）留给后续任务。

/** 已绑过事件的标记：放在按钮上而不是容器上——shell 每次重渲染都会换一批新按钮，容器标记会误伤。 */
const ENHANCED_ATTR = 'data-jj-enhanced';

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

/** 外链统一新窗口打开并带 noopener；只处理 href 以 http 开头的链接（站内锚点/相对链接不动）。 */
function markExternalLinks(container) {
  for (const link of container.querySelectorAll('a[href^="http"]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
  }
}

/**
 * 渲染后增强：代码复制按钮 + 外链属性。
 * @param {Element|DocumentFragment} container 渲染容器（shell 的 #content）
 * @param {{baseUrl?: string}} options baseUrl 预留给后续任务（图片占位等），本任务不使用
 */
export function enhance(container, { baseUrl } = {}) {
  void baseUrl; // 预留参数：保持与 brief Interfaces 一致的签名，本任务只做复制与外链
  if (!container || typeof container.querySelectorAll !== 'function') {
    return;
  }
  for (const btn of container.querySelectorAll('.code-wrap button.copy')) {
    bindCopyButton(btn);
  }
  // 纯属性设置天然幂等（重复设成同一个值），不需要打标记
  markExternalLinks(container);
}
