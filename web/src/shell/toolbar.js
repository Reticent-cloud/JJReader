// 工具条与 Aa 排版面板（Task 12 从 main.js 拆出，行为不变）：
// 工具条按钮与面板控件全部用 DOM API 创建（不拼 HTML），统一的 class/title 便于 CSS 与可访问性。

/** 工具条按钮工厂：label 文案 + id + title 提示（无 title 时省略属性）。 */
export function createToolbarButton(label, id, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool';
  button.id = id;
  if (title) {
    button.title = title;
  }
  button.textContent = label;
  return button;
}

// Aa 面板的行/档位定义（与 spec §5.5 口径一致；行宽 0 = 全宽）。
const WIDTH_OPTIONS = [
  { value: '640', label: '640' },
  { value: '780', label: '780' },
  { value: '960', label: '960' },
  { value: '0', label: '全宽' },
];

const CJK_FONT_OPTIONS = [
  { value: 'system', label: '系统默认' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'Source Han Sans SC', label: '思源黑体' },
];

const MONO_FONT_OPTIONS = [
  { value: 'consolas', label: 'Consolas' },
  { value: 'Cascadia Mono', label: 'Cascadia Mono' },
];

/** 带数值回显的滑杆行（字号/行距）。滑杆的 aria 当前值由 main.js 的 syncAaControls 同步。 */
function createRangeRow(labelText, setting, min, max, step, value) {
  const row = document.createElement('label');
  row.className = 'aa-row';
  const text = document.createElement('span');
  text.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.setting = setting;
  // T12 评审 Minor e：滑杆的无障碍当前值（后续由 syncAaControls 随设置更新）
  input.setAttribute('aria-valuemin', String(min));
  input.setAttribute('aria-valuemax', String(max));
  input.setAttribute('aria-valuenow', String(value));
  const output = document.createElement('output');
  output.className = 'aa-value';
  output.textContent = String(value);
  row.append(text, input, output);
  return row;
}

/** 下拉选择行（行宽/字体）。 */
function createSelectRow(labelText, setting, options, value) {
  const row = document.createElement('label');
  row.className = 'aa-row';
  const text = document.createElement('span');
  text.textContent = labelText;
  const select = document.createElement('select');
  select.dataset.setting = setting;
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    select.append(item);
  }
  select.value = value;
  row.append(text, select);
  return row;
}

/** 轻量排版 popover（字号/行距/行宽/中文字体/代码字体），默认隐藏。 */
export function buildAaPanel() {
  const panel = document.createElement('div');
  panel.id = 'aa-panel';
  panel.className = 'aa-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '排版');
  panel.append(
    createRangeRow('字号', 'fontSize', 14, 24, 1, 16),
    createRangeRow('行距', 'lineHeight', 1.4, 2.0, 0.1, 1.7),
    createSelectRow('行宽', 'contentWidth', WIDTH_OPTIONS, '780'),
    createSelectRow('中文字体', 'cjkFont', CJK_FONT_OPTIONS, 'system'),
    createSelectRow('代码字体', 'monoFont', MONO_FONT_OPTIONS, 'consolas'),
  );
  return panel;
}

/**
 * 构建工具条骨架：打开文件 / 打开文件夹 / 浏览根（文件树，Task 14）/ 回到大纲 / 目录 / 最近 /
 * 导出 PDF（Task 15）/ 弹性空隙 / 主题 / Aa / 关于（Task 16）（既有按钮顺序与 Task 10 一致，既有测试按 id 取按钮；
 * Task 13 新增两个打开入口，与 Ctrl+O / Ctrl+Shift+O 同口径）。「最近」菜单的内容由 main.js 用 renderRecent 渲染到 #recent-menu。
 * 导出按钮在未打开文档时禁用（main.js 在 load 后启用），与 Ctrl+E 共用同一导出入口；
 * 「关于」的 title 会由 main.js 随宿主下发的 assocState 更新（默认 .md 程序 / 尚未设为默认）。
 * @returns {{ element: HTMLElement, openFile: HTMLButtonElement, openFolder: HTMLButtonElement, browseRoot: HTMLButtonElement, treeBack: HTMLButtonElement, tocToggle: HTMLButtonElement, recentToggle: HTMLButtonElement, exportPdf: HTMLButtonElement, themeToggle: HTMLButtonElement, aaToggle: HTMLButtonElement, about: HTMLButtonElement }}
 */
export function createToolbar() {
  const toolbar = document.createElement('header');
  toolbar.id = 'toolbar';

  const openFile = createToolbarButton('打开文件', 'open-file', '打开 Markdown 文件（Ctrl+O）');
  const openFolder = createToolbarButton('打开文件夹', 'open-folder', '选择文件夹（Ctrl+Shift+O）');
  // Task 14：文件树浏览时显示根目录名（点击切回树）与「大纲」返回按钮；未打开文件夹时都隐藏。
  const browseRoot = createToolbarButton('', 'browse-root', '显示文件树');
  browseRoot.hidden = true;
  browseRoot.classList.add('browse-root');
  const treeBack = createToolbarButton('大纲', 'tree-back', '回到大纲');
  treeBack.hidden = true;
  const tocToggle = createToolbarButton('目录', 'toc-toggle', '大纲（Ctrl+B）');
  const recentToggle = createToolbarButton('最近', 'recent-toggle', '最近文件');
  recentToggle.setAttribute('aria-expanded', 'false');
  recentToggle.setAttribute('aria-controls', 'recent-menu');
  // Task 15：PDF 导出（无文档时 disabled，load 后由 main.js 启用）
  const exportPdf = createToolbarButton('导出 PDF', 'export-pdf', '导出 PDF（Ctrl+E）');
  exportPdf.disabled = true;
  const themeToggle = createToolbarButton('跟随系统', 'theme-toggle', '主题：浅色 → 深色 → 跟随系统');
  const aaToggle = createToolbarButton('Aa', 'aa-toggle', '排版设置（Ctrl+,）');
  aaToggle.setAttribute('aria-expanded', 'false');
  aaToggle.setAttribute('aria-controls', 'aa-panel');
  // Task 16：关于面板入口（打开后由宿主弹出模态窗口；title 随 assocState 更新）
  const about = createToolbarButton('关于', 'about', '关于鲸鲸阅读器');
  const spacer = document.createElement('div');
  spacer.className = 'toolbar-spacer';
  toolbar.append(
    openFile,
    openFolder,
    browseRoot,
    treeBack,
    tocToggle,
    recentToggle,
    exportPdf,
    spacer,
    themeToggle,
    aaToggle,
    about,
  );

  return {
    element: toolbar,
    openFile,
    openFolder,
    browseRoot,
    treeBack,
    tocToggle,
    recentToggle,
    exportPdf,
    themeToggle,
    aaToggle,
    about,
  };
}

/** 主题按钮文案（三态各一个中文标签）。 */
export function themeLabel(theme) {
  switch (theme) {
    case 'light':
      return '浅色';
    case 'dark':
      return '深色';
    default:
      return '跟随系统';
  }
}
