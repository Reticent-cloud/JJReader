# 顶栏/目录栏 chrome 配色、鲸鱼蓝配色维度与自绘标题栏实施报告

- 日期：2026-10-19
- 需求（原话，按追加顺序）：
  1. 「最上面那个 TOPBAR 不要用圆角，目录栏和标题行用颜色与正文区分，参考 Workbuddy 这样的形式，可以选择蓝色主题」
  2. 「最上面窗口标题栏那一条也要跟着变色」（Win10 不支持 `DWMWA_CAPTION_COLOR`，需自绘标题栏）
  3. 「主题改成鲸鱼蓝」：蓝色配色正式命名「鲸鱼蓝」，浅色正文改浅蓝白（不要纯白，降低对比刺激）；`blue` label 改为「鲸鱼蓝」
- 参考形态：WorkBuddy——侧栏与顶栏有区别于正文的浅色底，正文区不刺眼；顶栏直角。
- 范围：前端设置 / Aa 面板 / 主题样式；宿主 `AppSettings` 与 `SettingsPatch`；自绘标题栏（WPF）；
  前端与宿主测试；README、spec §5.1/§5.4、手测清单。不改渲染管线、消息协议与验收门槛；
  `scripts/verify.ps1` 仍为 16 项判据。本报告与全部改动同属一个中文 commit。

## 1. 改法

### 1.1 chrome 与正文分离

- `#toolbar`：去掉 v3 的底部大圆角（`border-radius: 0`，直角）；背景由「半透明 + `backdrop-filter: blur(8px)`」改为不透明实色 `var(--chrome-bg)`；保留底部 1px `var(--chrome-border)` 分隔线。
- `#toc`：背景改 `var(--chrome-bg)`，右侧 1px `var(--chrome-border)`；TOC/文件树的 hover 改用 `var(--chrome-hover-bg)`。
- 正文区：`#content` 背景改 `var(--content-bg)`（浅色为浅蓝白，**不是纯白**；深色为更深的蓝黑），`#app` 同色保证通知行连续。
- 通知条、最近菜单、Aa 面板、toast、回到顶部按钮的配色未改动；打印/PDF 仍由 `print.css` 统一压成纯白。
- `--toolbar-bg` / `--toolbar-border` 不再被顶栏读取，保留为兼容别名并指向 `var(--chrome-bg)` / `var(--chrome-border)`。

### 1.2 配色维度（palette）与色值

| 主题 | 配色 | chrome 底 | chrome 边框 | 正文底 | TOC active 底 | 按钮 hover |
| --- | --- | --- | --- | --- | --- | --- |
| 浅色 | blue 鲸鱼蓝（默认） | `#e6efff` | `#c9d9f7` | `#f3f8ff` | `#d8e6ff` | `#d9e6ff` |
| 浅色 | default | `#f3f4f6` | `#e2e4e8` | `#fafbfc` | `#eef0f4` | `#eaedf1` |
| 深色 | blue 鲸鱼蓝（默认） | `#101a2e` | `#22304a` | `#0c1424` | `#1b2a4a` | `#18243c` |
| 深色 | default | `#16181d` | `#2a2d34` | `#0d0f13` | `#2b2f3a` | `#1f222a` |

- 变量：`--chrome-bg`、`--chrome-border`、`--chrome-hover-bg`、`--chrome-active-bg`、`--content-bg`；TOC 当前项沿用 `--toc-active-bg`。
- 定义位置：`base.css :root` 给首屏兜底（鲸鱼蓝浅色）；`light.css` / `dark.css` 给鲸鱼蓝两套主题值（含系统深色首屏兜底）；`overrides.css` 在 light/dark 之后拼接，用 `html[data-palette='default']`、`html[data-theme='dark'][data-palette='default']` 覆盖中性两套主题——`data-palette` 与 `data-theme` 正交，四种组合互不覆盖。
- 正文浅蓝白（需求 3）：鲸鱼蓝浅色 `--content-bg: #f3f8ff`；代码块 `--code-bg: #e8f0fd`（与正文底可见差异）、表格/行内代码/引用在 `overrides.css` 的 `html[data-palette='blue']:not([data-theme='dark'])` 下给同档浅蓝；中性「默认」浅色正文 `#fafbfc`、代码块回中性浅灰 `#f6f8fa`。深色正文 `#0c1424`（鲸鱼蓝）/ `#0d0f13`（默认）。
- 对比度：正文文字 `#1f2328` 对 `#f3f8ff` ≈ 14.8:1（≥7:1）；`--fg-muted #59636e` 对 `#f3f8ff` ≈ 5.7:1（≥4.5:1）；工具条/TOC active 文本用 `--ui-accent-strong #3a55e8`，在 active 浅蓝底上 ≈ 4.6–4.7:1（AA）。
- 未知 palette 值由 CSS 自然回退到鲸鱼蓝（没有 `data-palette='xxx'` 匹配规则），JS 侧另有 `normalizePalette` 兜底。

### 1.3 前端设置与 Aa 面板

- `web/src/settings.js`：`PALETTES = ['default','blue']`、`PALETTE_DEFAULT = 'blue'`、`normalizePalette()`；`DEFAULT_SETTINGS.palette = 'blue'`；`normalizeSettings` 归一 palette；`applySettings` 写 `document.documentElement.dataset.palette`；`settingsPatch` 自然携带 `palette`。
- `web/src/shell/toolbar.js`：Aa 面板新增 `createSelectRow('配色', 'palette', [{value:'default',label:'默认'},{value:'blue',label:'鲸鱼蓝'}], 'blue')`。下拉 `change` 走既有 `onAaControlChange → updateSettings`：即时写 `data-palette`，并只发 `saveSettings{patch:{palette}}`。
- 宿主下发的旧设置没有 palette 时，`load`/`settings` 都先与 `DEFAULT_SETTINGS` 合并，显示鲸鱼蓝；Aa 回显（`syncAaControls`）自动跟随。
- 宿主 `saveSettings` 收到 palette/theme 后除落盘外还会刷新标题栏配色（见 §1.4）。

### 1.4 自绘标题栏（Win10 无法给系统标题栏上色）

- `MainWindow.xaml`：`WindowStyle="None"` + `WindowChrome`（`CaptionHeight=32`、`ResizeBorderThickness=6`、`GlassFrameThickness=0`、`CornerRadius=0`、`UseAeroCaptionButtons=False`）；根网格两行：32 DIP 标题栏 + WebView2 内容。
- 标题栏：16px 应用图标（`app.ico` 作为 WPF Resource）+ `文件名 — 鲸鲸阅读器`（TextBlock）+ 最小化 / 最大化(还原) / 关闭（Segoe MDL2 Assets 字形；关闭按钮 hover 红 `#E81123`、按下 `#C50F1F`）；底部 1px 分隔线。窗口 `Title` 仍同步设置，任务栏/无障碍不受影响。
- 颜色与前端 chrome 一致（`TitleBarTheme.Resolve`）：浅色鲸鱼蓝标题栏 `#E6EFFF`/边框 `#C9D9F7`、正文色 `#F3F8FF`；深色鲸鱼蓝 `#101A2E`/`#22304A`、`#0C1424`；default 浅色 `#F3F4F6`/`#E2E4E8`、`#FAFBFC`；default 深色 `#16181D`/`#2A2D34`、`#0D0F13`。按钮 hover/active 用与前端一致的 `--chrome-hover-bg`/`--chrome-active-bg` 对应色（blue 浅 `#D9E6FF`/`#D4E3FF`，default 浅 `#EAEDF1`/`#E0E5EC`；深色同理）。关闭按钮红色状态与主题无关。
- 明暗解析：`TitleBarTheme.ResolveLightTheme(theme, AppsUseLightTheme)`——前端主题 `light`/`dark` 直接跟随（保证标题栏与页面 chrome 始终一致），`system`/非法值才读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`；监听 `WM_SETTINGCHANGE`/`WM_THEMECHANGED`，系统主题切换即时重算。标题栏随 palette/主题保存即时刷新。
- 窗口交互：
  - `WM_GETMINMAXINFO` 把最大化尺寸/位置夹到当前显示器工作区（修复 WindowChrome 最大化时按 resize border 外溢、裁掉标题栏/盖住任务栏；实测最大化 3840×2080 @0,0，还原恢复原尺寸）。
  - `WM_NCLBUTTONDBLCLK(HTCAPTION)` 显式双击最大化/还原（caption 是 non-client，WPF 收不到 MouseDoubleClick）；实测双击 → 最大化、再双击 → 还原。
  - 拖动移动、Aero Snap、`Alt+F4` 由 WindowChrome/系统默认行为保留；标题栏右键 `MouseRightButtonUp` 调 `SystemCommands.ShowSystemMenu`（系统默认右键菜单也保留）。
  - 状态变化时最大化按钮切成「还原」字形与 tooltip（`TitleBarTheme.MaximizeButtonGlyph/Tooltip`）。
  - WebView2 内容四周留 6 DIP（与 `ResizeBorderThickness` 一致）：WebView2 独立子 HWND 不盖住窗口边缘，WPF/WindowChrome 才能命中四周缩放；露出底色与正文同色，视觉不可见。
  - 高 DPI：全部使用 DIP（32、46×32、16、6），随 PerMonitorV2 缩放。
- 窗口几何、`RestoreBounds`、最小尺寸 640×480、最大化恢复逻辑均保持原 `WindowGeometryClamp` 行为不变；离屏 `--verify-render/--verify-pdf` 窗口同样走新 XAML，不写回几何。

### 1.5 宿主设置

- `src/Host/Store.cs`：`AppSettings` 末尾新增 `string Palette = "blue"`（位置参数默认值，旧 `settings.json` 缺字段时取 blue）。
- `src/Host/SettingsPatch.cs`：新增 `palette` 合并（camelCase 与 theme 等一致）；白名单只接受 `default`/`blue`，非法字符串/类型不符/空串忽略并保持当前值（默认 blue；前端 normalize 同样回落 blue）。

### 1.6 打印

- `print.css` 未改动：打印模式隐藏 `#toolbar`/`#toc` 等 chrome，`body.print-mode #app/#toc/#content` 强制 `background: #ffffff !important`，不继承 chrome/浅蓝底；新增测试锁定该文件不出现 `--chrome-*` / `data-palette`。

## 2. 测试与构建

| 项目 | 结果 |
| --- | --- |
| 前端 `cd web && npm test` | **497 passed / 0 skipped**（21 个测试文件；原 488，新增 9 例：settings/Aa 配色 2 例 + ui-css 7 例） |
| 宿主 `dotnet test tests/host` | **426 passed / 0 failed / 0 skipped**（原 386；工作区 `dotnet test` 受已知 `Win32Exception(5)` 限制，按惯例导出到 ASCII 路径 `D:\jj-palette-check` 运行） |
| 安装器 `dotnet test tests/installer` | **67 passed / 0 failed / 0 skipped** |
| `scripts/build.ps1` | **BUILD OK**；`md-engine.js 493.5 KB`（内联 CSS 44662 字符，低于 640 KB 门禁） |

新增/修改的测试：

- 前端 `tests/web/shell-ui.test.js`：默认鲸鱼蓝、非法值回退 blue、`applySettings` 写 `data-palette`、palette 与 theme 正交、`settingsPatch` 携带 palette；Aa 面板「配色」下拉的选项（默认/鲸鱼蓝）/回显/切换即时生效/只发 `{palette}`；`load` 下发 palette 回显。
- 前端 `tests/web/ui-css.test.js`：`#toolbar` 无圆角且用 chrome 实色底、无 `backdrop-filter`、不再读 `--toolbar-bg`；`#toc` chrome 底 + 分隔线；`#content` content 底；鲸鱼蓝/default 两套 palette 变量（含首屏兜底）齐备；正文浅蓝白（`#f3f8ff`）与代码块底差异；WCAG 对比度（正文 ≥7:1、次要文字 ≥4.5:1）；工具条 hover/active 对比色；打印不继承 chrome 色。
- 宿主 `tests/host/StoreTests.cs`：默认 palette=blue、palette 落盘往返、旧 settings.json 无 palette ⇒ blue、camelCase JSON 含 `"palette": "blue"`。
- 宿主 `tests/host/SettingsPatchTests.cs`：patch 合并 `palette:"default"`、缺字段保持、类型不符忽略、非法值（`ocean`/`Blue`/空串）保持默认 blue。
- 宿主 `tests/host/TitleBarThemeTests.cs`：palette 归一；四种 palette×明暗组合的标题栏色值；非法 palette 回退；`IsLightAppsTheme`（1/0/字符串/缺省）；`ResolveLightTheme`（固定主题优先、system 跟系统）；标题文案（空/文件名）；最大化按钮字形/tooltip；CaptionHeight=32。

## 3. 验收（verify.ps1，干净克隆）

- 干净克隆：`D:\jj-palette-verify`（`git clone` 自工作仓库），`master @` 本报告的提交。
- 命令：`pwsh -NoProfile -File scripts/verify.ps1`（PowerShell 7.6.6 Core；`verify.ps1` 无 BOM，Windows PowerShell 5.1 会按 ANSI 解析中文而失败，沿用惯例用 pwsh）。
- 结果：**VERIFY OK**，16 项 = **15 PASS + 1 既有 WARN + 0 FAIL**（WARN 为端到端首屏：渲染器口径 `elapsedMs` 约 0.1 s，含 WebView2 初始化的墙钟约 1.0–1.1 s，属既有口径说明，不计失败）。
- 关键证据：宿主单测 426/426、前端 497/497、构建成功、`out\` 分发包完整、full-syntax `tocCount=38`、5 万行 `tocCount=500`、宿主私有内存峰值 ≤200 MB、PDF hello/5 万行体积与页数达标、双开单实例 1 个进程、前端产物 506365 B 且与 Resources 字节一致（SHA256 相同）、用户 `%APPDATA%\JingjingReader\recent.json` 未被改写。
- 说明：克隆里构建会以 LF 重写 `src/Host/Resources/md-engine.js`，因此验收报告显示「工作树 有 1 个未提交变更」；这是既有 `core.autocrlf` 与构建产物的行尾差异，不是代码改动。
- `docs/verify-checklist.md` 新增手测项：自绘标题栏（颜色/按钮/拖动/双击/系统菜单/DPI/最大化）、顶栏直角与 chrome 分区、正文浅蓝白与代码块差异、深浅色×两配色、AA 对比、打印纯白。

## 4. 需人工手测

自动测试只能锁色值映射、变量/选择器、设置链路与窗口消息逻辑；像素级观感与真实鼠标交互仍需按 `docs/verify-checklist.md §4` 执行：

1. 浅色 + 鲸鱼蓝：标题栏/顶栏/目录栏浅蓝底（`#e6efff`）、正文浅蓝白（`#f3f8ff`）、顶栏直角、目录栏右分隔线清晰；标题栏与顶栏颜色连续。
2. 深色 + 鲸鱼蓝：标题栏/顶栏/目录栏深蓝（`#101a2e`）、正文蓝黑（`#0c1424`），目录当前项与按钮可辨。
3. 浅色/深色 × 中性「默认」：chrome 变灰、正文微灰/更深，与鲸鱼蓝切换即时生效。
4. 标题栏：拖动移动、双击最大化/还原、最大化按钮切「还原」、右键系统菜单、Aero Snap、`Alt+F4`、关闭按钮红色 hover；最大化不裁标题栏、不盖任务栏；125%/200% DPI 下图标/文字/按钮清晰。
5. 切换 Aa「配色」或主题按钮后标题栏即时变色；重启后配色保持；删除 `palette` 字段后显示鲸鱼蓝。
6. 打印预览与 `Ctrl+E` 导出：标题栏/顶栏/目录栏隐藏、纸面纯白、无 chrome/浅蓝底残影。
7. 通知条、toast、最近菜单、Aa 面板浮在 chrome/正文上时无配色冲突。

## 5. Concerns / 已知限制

- 手测项（§4）本轮未全部执行：自动验收不产出视觉基线，仓库按惯例不提交截图；已用本地离屏窗口截图核对浅色/深色 × 鲸鱼蓝/默认四种标题栏与浅色整窗观感，真实鼠标拖动/Aero Snap/高 DPI 仍需人工确认。
- 标题栏明暗按「前端主题设置优先、system 跟系统」解析（而非无条件跟系统）：否则用户把主题固定为深色时，页面 chrome 是深色而标题栏仍是系统浅色，出现断层。需求原文的「系统明暗 + WM_SETTINGCHANGE」在 `theme=system`（默认）时完全成立。
- `SettingsPatch` 对 palette 做白名单校验（非法值忽略并保持当前值），`Store.LoadSettings` 不做值归一；手改 `settings.json` 写入非法 palette 时，宿主原样下发、前端 normalize 显示鲸鱼蓝——文件里会保留非法字符串直到下一次保存（与 theme 的前端归一口径一致）。
- WebView2 四周 6 DIP 是为保留缩放热区；页面内容因此比窗口小 12 DIP（左右 6 + 底部 6）。底色与正文同色，正常观感不可见。
- `--toolbar-bg` / `--toolbar-border` 已成为兼容别名；除顶栏外无其它使用方，打印样式不引用，后续如无外部依赖可择机删除。
