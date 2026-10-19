# 顶栏/目录栏 chrome 配色、默认白色配色、自绘标题栏与分区底板实施报告

- 日期：2026-10-19
- 需求（原话，按追加顺序）：
  1. 「最上面那个 TOPBAR 不要用圆角，目录栏和标题行用颜色与正文区分，参考 Workbuddy 这样的形式，可以选择蓝色主题」
  2. 「最上面窗口标题栏那一条也要跟着变色」（Win10 不支持 `DWMWA_CAPTION_COLOR`，需自绘标题栏）
  3. 蓝色正式命名「鲸鱼蓝」；浅色正文改浅蓝白（护眼）
  4. 「主题第一次打开默认为白色，浅色主题现在也是蓝色，改回白色」——默认配色改回 `default`（浅色正文纯白），鲸鱼蓝保留为可选项
  5. 「目录栏左侧/下侧有两条颜色不匹配的长条」——WebView 四周 6 DIP 缩放边距露出的颜色要与相邻区域一致（分区底板）
- 范围：前端设置 / Aa 面板 / 主题样式；宿主 `AppSettings` 与 `SettingsPatch`；自绘标题栏与分区底板（WPF）；
  前端与宿主测试；README、spec §5.1/§5.4、手测清单。不改渲染管线、消息协议与验收门槛；
  `scripts/verify.ps1` 仍为 16 项判据。本报告与全部改动同属一个中文 commit。

## 1. 改法

### 1.1 chrome 与正文分离

- `#toolbar`：去掉底部大圆角（`border-radius: 0`，直角）；背景为不透明实色 `var(--chrome-bg)`；保留底部 1px `var(--chrome-border)` 分隔线。
- `#toc`：背景 `var(--chrome-bg)`，右侧 1px `var(--chrome-border)`；TOC/文件树 hover 用 `var(--chrome-hover-bg)`。
- 正文区：`#content` 背景 `var(--content-bg)`——默认**纯白**，鲸鱼蓝下浅蓝白，深色下更深的蓝黑；`#app` 同色保证通知行连续。
- 通知条、最近菜单、Aa 面板、toast、回到顶部按钮不受影响；打印/PDF 仍由 `print.css` 统一压成纯白。

### 1.2 配色维度（palette）：默认白色 + 鲸鱼蓝可选

| 主题 | 配色 | chrome 底 | chrome 边框 | 正文底 | TOC active 底 | 按钮 hover |
| --- | --- | --- | --- | --- | --- | --- |
| 浅色 | default（默认） | `#f3f4f6` | `#e2e4e8` | `#ffffff` | `#eef0f4` | `#eaedf1` |
| 浅色 | blue 鲸鱼蓝（可选） | `#e6efff` | `#c9d9f7` | `#f3f8ff` | `#d8e6ff` | `#d9e6ff` |
| 深色 | default（默认） | `#16181d` | `#2a2d34` | `#0d0f13` | `#2b2f3a` | `#1f222a` |
| 深色 | blue 鲸鱼蓝（可选） | `#101a2e` | `#22304a` | `#0c1424` | `#1b2a4a` | `#18243c` |

- 变量：`--chrome-bg`、`--chrome-border`、`--chrome-hover-bg`、`--chrome-active-bg`、`--content-bg`；TOC 当前项沿用 `--toc-active-bg`。
- 定义位置：`base.css :root` 给首屏兜底（默认中性浅色，白底）；`light.css`/`dark.css` 给 default 两套主题值（含系统深色首屏兜底）；`overrides.css` 在 light/dark 之后拼接，用 `html[data-palette='blue']:not([data-theme='dark'])` 与 `html[data-theme='dark'][data-palette='blue']` 覆盖鲸鱼蓝——`data-palette` 与 `data-theme` 正交，四种组合互不覆盖。
- 鲸鱼蓝浅色代码块/表格/行内代码/引用有同档浅蓝底（`#e8f0fd` 等）与浅蓝白正文可见差异；default 浅色正文纯白、代码块浅灰 `#f6f8fa`。
- 对比度：正文文字 `#1f2328` 对 `#ffffff` ≈ 16.9:1、对 `#f3f8ff` ≈ 14.8:1（≥7:1）；`--fg-muted #59636e` 对两种底色均 ≥ 5.7:1（≥4.5:1）；工具条/TOC active 文本用 `--ui-accent-strong #3a55e8`，active 浅色底上 ≈ 4.6–4.7:1（AA）。
- 未知/缺省 palette 由前端 `normalizePalette`、宿主 `SettingsPatch`、CSS 匹配规则三处共同回落 `default`（白）。

### 1.3 前端设置与 Aa 面板

- `web/src/settings.js`：`PALETTES = ['default','blue']`、`PALETTE_DEFAULT = 'default'`、`normalizePalette()`（只认 `blue`，其余回落 default）；`DEFAULT_SETTINGS.palette = 'default'`；`normalizeSettings` 归一；`applySettings` 写 `document.documentElement.dataset.palette`；`settingsPatch` 自然携带 palette。
- `src/Host/Resources/index.html`：`<html lang="zh-CN" data-palette="default">`，首屏先按默认白色渲染，避免加载后蓝闪。
- `web/src/shell/toolbar.js`：Aa 面板「配色」下拉为 `默认 / 鲸鱼蓝`，初始/默认值 `default`；`change` 走既有 `onAaControlChange → updateSettings`，即时写 `data-palette` 且只发 `saveSettings{patch:{palette}}`。
- 旧 settings.json 中没有 palette：`load`/`settings` 与 `DEFAULT_SETTINGS` 合并 → 默认白色；旧文件里已有 `palette=blue` 时保留鲸鱼蓝（不强制重置）。

### 1.4 自绘标题栏（Win10 无法给系统标题栏上色）

- `MainWindow.xaml`：`WindowStyle="None"` + `WindowChrome`（`CaptionHeight=32`、`ResizeBorderThickness=6`、`GlassFrameThickness=0`、`CornerRadius=0`、`UseAeroCaptionButtons=False`）；根网格两行：32 DIP 标题栏 + WebView2 内容。
- 标题栏：16px 应用图标（`app.ico` 作为 WPF Resource）+ `文件名 — 鲸鲸阅读器`（TextBlock）+ 最小化 / 最大化(还原) / 关闭（Segoe MDL2 Assets；关闭按钮 hover 红 `#E81123`、按下 `#C50F1F`）；底部 1px 分隔线。窗口 `Title` 仍同步设置，任务栏/无障碍不受影响；`SetTitle` 同时更新 TextBlock。
- 颜色与前端 chrome 一致（`TitleBarTheme.Resolve`）：浅色 default `#F3F4F6`/`#E2E4E8`、正文 `#FFFFFF`；浅色 blue `#E6EFFF`/`#C9D9F7`、`#F3F8FF`；深色 default `#16181D`/`#2A2D34`、`#0D0F13`；深色 blue `#101A2E`/`#22304A`、`#0C1424`。按钮 hover/active 用与前端一致的 `--chrome-hover-bg`/`--chrome-active-bg` 对应色。XAML 初始画刷/`Window.Background` 为**默认白色的中性色**，避免首帧蓝底。
- 明暗解析：`TitleBarTheme.ResolveLightTheme(theme, AppsUseLightTheme)`——前端主题 `light`/`dark` 直接跟随（保证标题栏与页面 chrome 一致），`system`/非法值读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`；监听 `WM_SETTINGCHANGE`/`WM_THEMECHANGED` 即时刷新；palette/主题保存后立即重算。
- 窗口交互：`WM_GETMINMAXINFO` 把最大化尺寸/位置夹到当前显示器工作区（最大化不裁标题栏/不盖任务栏）；`WM_NCLBUTTONDBLCLK(HTCAPTION)` 显式双击最大化/还原；拖动、Aero Snap、`Alt+F4` 由 WindowChrome/系统默认保留；右键标题栏调 `SystemCommands.ShowSystemMenu`；状态变化切「还原」图标与 tooltip。窗口几何/`RestoreBounds`/最小尺寸 640×480 保持不变。

### 1.5 分区底板（修复左侧/底部两条颜色不匹配的长条）

- 原因：WebView2 是独立子 HWND，为保留 WindowChrome 四边缩放热区而留 6 DIP 边距；边距露出的是 `Window.Background`（单一正文色），左侧/底部左侧因此与目录栏 chrome 色不一致。
- 改法：在 WebView2 **下方**铺一层 `ChromeBackdrop` 分区底板（两列）：左列宽 = `TocWidth`（已含 1px 分隔线）+ 6 DIP 左边距，填 chrome 色；右列填正文色。WebView2 仍保留 6 DIP 边距并盖在底板上，于是四条边距都与相邻区域同色。
- 同步：`ApplyTitleBarTheme` 同时更新底板两色、宽度；宽度取自 `settings.TocWidth`，`tocVisible=false` 时左列归 0（整条为正文色）。`saveSettings` 回传 `tocWidth`/`tocVisible` 后重算；窗口缩放、最大化时按 DIP 自动跟随。
- 纯函数 `TitleBarTheme.BackdropTocWidth(tocVisible, tocWidth)` 负责宽度（含 `ContentMargin=6`），宿主测试覆盖 240→246、180→186、折叠→0。
- 颜色与窗口四边缩放热区不变（仍保留 `ResizeBorderThickness=6` 与 `Margin="6,0,6,6"`）。

### 1.6 宿主设置

- `src/Host/Store.cs`：`AppSettings` 末尾 `string Palette = "default"`（位置参数默认值，旧 settings.json 缺字段 → default 白色）。
- `src/Host/SettingsPatch.cs`：`palette` 合并（camelCase 与 theme 等一致）；白名单只接受 `default`/`blue`，非法字符串/类型不符/空串忽略并保持当前值（默认 default；前端 normalize 同样回落 default）。
- `Protocol.Settings/Load` 直接序列化 `AppSettings`，payload 自动带 `palette`，无协议类型变化。

### 1.7 打印

- `print.css` 未改动：打印模式隐藏 `#toolbar`/`#toc` 等 chrome，`body.print-mode #app/#toc/#content` 强制 `background: #ffffff !important`，不继承 chrome/浅蓝底；测试锁定该文件不出现 `--chrome-*` / `data-palette`。

## 2. 测试与构建

| 项目 | 结果 |
| --- | --- |
| 前端 `cd web && npm test` | **498 passed / 0 skipped**（21 个测试文件；原 488） |
| 宿主 `dotnet test tests/host` | **432 passed / 0 failed / 0 skipped**（原 386；主仓库受已知 `Win32Exception(5)` 限制，按惯例导出到 ASCII 路径运行） |
| 安装器 `dotnet test tests/installer` | **67 passed / 0 failed / 0 skipped** |
| `scripts/build.ps1` | **BUILD OK**；`md-engine.js` 492.0 KB（内联 CSS 44077 字符，低于 640 KB 门禁） |

新增/修改的测试：

- 前端 `tests/web/shell-ui.test.js`：默认 default（白）、非法值回退 default、`applySettings` 写 `data-palette`、palette 与 theme 正交、`settingsPatch` 携带；Aa 下拉默认「默认」、切鲸鱼蓝/切回默认只发 `{palette}`；load 下发 palette 回显。
- 前端 `tests/web/ui-css.test.js`：default 两主题变量（白底/中性 chrome）、鲸鱼蓝浅色/深色覆盖块、鲸鱼蓝代码/表格底差异、`index.html` 预置 `data-palette="default"`、WCAG 对比度（两种浅色底）、打印不继承 chrome 色、顶栏直角/目录栏/正文底变量。
- 宿主 `tests/host/StoreTests.cs`：默认 palette=default、blue 落盘往返、旧 settings.json 无 palette ⇒ default、camelCase JSON `"palette": "default"`。
- 宿主 `tests/host/SettingsPatchTests.cs`：合并 default/blue、缺字段保持、类型不符忽略、非法值保持 default。
- 宿主 `tests/host/TitleBarThemeTests.cs`：palette 归一（缺省/非法 → default）、四种 palette×明暗色值、`IsLightAppsTheme`、`ResolveLightTheme`、标题文案、最大化按钮、`BackdropTocWidth`（246/186/6/0）。

## 3. 验收（verify.ps1，干净克隆）

- 干净克隆：`D:\jj-palette-verify`（`git clone` 自工作仓库），`master @` 本报告的提交。
- 命令：`pwsh -NoProfile -File scripts/verify.ps1`（PowerShell 7.6.6 Core；`verify.ps1` 无 BOM，Windows PowerShell 5.1 会按 ANSI 解析中文而失败，沿用惯例用 pwsh）。
- 结果：**VERIFY OK**，16 项 = **15 PASS + 1 既有 WARN + 0 FAIL**（WARN 为端到端首屏：渲染器口径 `elapsedMs` 约 0.1 s，含 WebView2 初始化的墙钟约 1.0–1.1 s，属既有口径说明，不计失败）。
- 关键证据：宿主单测 432/432、前端 498/498、构建成功、`out\` 分发包完整、full-syntax `tocCount=38`、5 万行 `tocCount=500`、宿主私有内存峰值 ≤200 MB、PDF hello/5 万行体积与页数达标、双开单实例 1 个进程、前端产物与 Resources 字节一致（SHA256 相同）、用户 `%APPDATA%\JingjingReader\recent.json` 未被改写。
- 说明：克隆里构建会以 LF 重写 `src/Host/Resources/md-engine.js`，因此验收报告显示「工作树 有 1 个未提交变更」；这是既有 `core.autocrlf` 与构建产物的行尾差异，不是代码改动。

## 4. 需人工手测

自动测试只能锁色值映射、变量/选择器、设置链路、窗口消息与底板宽度逻辑；像素级观感与真实鼠标交互仍需按 `docs/verify-checklist.md §4` 执行：

1. 首次启动/无 palette：标题栏/顶栏/目录栏中性浅灰、正文纯白；Aa「配色」显示「默认」。
2. 切「鲸鱼蓝」：标题栏/顶栏/目录栏浅蓝 `#e6efff`、正文浅蓝白 `#f3f8ff`；切回默认恢复白色；重启后保持。
3. 左侧/底部无杂条：展开目录、折叠目录、拖动调宽目录、缩放/最大化窗口后，WebView 四周 6 DIP 边距始终与相邻目录栏 chrome / 正文同色；四边仍可拖拽缩放。
4. 标题栏：拖动、双击最大化/还原、最大化按钮切「还原」、右键系统菜单、Aero Snap、`Alt+F4`、关闭按钮红色 hover；最大化不裁标题栏/不盖任务栏；125%/200% DPI 下清晰。
5. 浅色/深色 × 默认/鲸鱼蓝四种组合：正文与当前项对比度（≥7:1 / ≥4.5:1）、代码块/表格底差异可见。
6. 打印预览与 `Ctrl+E`：标题栏/顶栏/目录栏/底板隐藏、纸面纯白，无 chrome/浅蓝底残影。

## 5. Concerns / 已知限制

- 手测项（§4）本轮只做了本地离屏窗口截图抽查（默认白、鲸鱼蓝、目录折叠、目录 320 宽；像素采样确认底板四边颜色与相邻区域一致），真实鼠标拖动/Aero Snap/高 DPI/右键菜单仍需人工确认。
- 标题栏明暗按「前端主题设置优先、system 跟系统」解析，而非无条件跟系统：否则固定深色主题时页面 chrome 深色而标题栏仍系统浅色，出现断层；`theme=system`（默认）时完全按系统。
- 分区底板只在 `saveSettings` 落盘后更新宽度：拖动目录宽度的**过程中**底部 strip 仍是旧宽度，松手（commit）后对齐；属可接受的瞬时差异。
- `SettingsPatch` 对 palette 做白名单校验（非法值忽略并保持当前值），`Store.LoadSettings` 不做值归一；手改 settings.json 写入非法 palette 时，宿主原样下发、前端 normalize 显示 default——文件里会保留非法字符串直到下一次保存（与 theme 的前端归一口径一致）。
- `--toolbar-bg` / `--toolbar-border` 已成为兼容别名；除顶栏外无使用方，打印样式不引用，后续如无外部依赖可择机删除。
