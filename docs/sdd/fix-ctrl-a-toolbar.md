# Ctrl+A 只选正文、工具栏常显、右上白边修复报告

- 日期：2026-10-28
- 基线：master `bdc0192`
- 需求（原话）：
  1. 「使用 ctrl+a 快捷键全选的时候不只选中了全文，连目录也一起选中了。」
  2. 「把工具栏右边的白边修复了」
  3. 「把工具栏固定显示」

## 1. 改法

### 1.1 Ctrl+A 只选正文（web）

- `web/src/shell/main.js`：
  - 新增 `selectArticleContent()`：`range.selectNodeContents(#content)` → `selection.removeAllRanges()` → `addRange`，只建立正文选区，工具栏/目录/通知条都不参与。函数随 `mountShell` 返回值导出（`shell.selectArticleContent()`），便于测试直接断言。
  - 全局 keydown 中 `Ctrl+A`（`Ctrl`/`Meta`，非 `Shift`）分支：打印模式（`body.print-mode`）或焦点在 Aa 面板/最近菜单内时直接返回（保留原行为）；否则 `preventDefault()` 并选中正文。
  - 复用现有 `isEditableTarget`：输入框/可编辑区内不拦截。
- `tests/web/shell-errors.test.js`：新增「Ctrl+A 只选正文」用例，断言 `defaultPrevented===true`、`selection.rangeCount===1`、`selection.anchorNode/focusNode` 是 `#content`、`Range.startContainer/endContainer` 是 `#content`，且 `#toc`/`#toolbar` 不包含锚点；另断言导出的 API 可独立选中。新增 Aa 面板/最近菜单焦点下不拦截、打印模式下不拦截两条用例。

### 1.2 工具栏右侧白边（宿主 WPF）

- 根因：WebView2 为保留缩放热区在内容行留 6 DIP 边距；原 `ChromeBackdrop` 只按「左列 = TocWidth+6 chrome / 其余正文色」分列。WebView 顶部不缩进，顶栏（前端 `--toolbar-height: 40px`）右侧那 6 DIP 落在正文列，露出白色。
- `src/Host/MainWindow.xaml`：`ChromeBackdrop` 改为两行两列——第 0 行（`ChromeBackdropTop`，横跨两列）填 chrome 色并带底部分隔线，高度 = 工具栏高度；第 1 行左列仍为目录 chrome（宽 TocWidth+6，带右侧分隔线），右列正文色。
- `src/Host/TitleBarTheme.cs`：新增 `ToolbarHeight = 40d`、`ContentTopMargin = 0d`、`BackdropTopHeight() = 40d`；`BackdropTocWidth()` 行为不变（折叠→0）。
  - 说明：需求文字里的「32 DIP」是自绘标题栏 `CaptionHeight`；内容行里实际顶栏是前端 `--toolbar-height: 40px`，且 WebView 顶部边距为 0。若按 32 DIP 填色，顶部 32–40 px 的右侧 6 DIP 仍会露白，因此实现按真实 40 DIP 取高，并在宿主单测中锁定。
- `src/Host/MainWindow.xaml.cs`：`ApplyTitleBarTheme` 同步 `ChromeBackdropTop` 的背景/边框与 `ChromeBackdropTopRow.Height`；颜色仍随 palette + 明暗更新。
- `tests/host/TitleBarThemeTests.cs`：新增 `BackdropTopHeight_covers_frontend_toolbar_and_top_margin`（40/0/40/32）。
- 效果：顶部右角 6 DIP 为 chrome 色且与工具栏底部分隔线对齐；其下右侧 6 DIP 为正文色；左下与底部维持原行为；目录折叠时左列 0。

### 1.3 工具栏常显（web）

- `web/src/shell/main.js`：删除顶部 40px 悬停/800ms 隐藏/Alt 切换逻辑（常量、timers、`root.dataset.toolbar`、focusin/focusout/mousemove/mouseenter/mouseleave 监听及其 destroy 解绑）。`Alt` 单键保留但无动作，不报错；`Esc` 只关浮层，不再隐藏工具条。
- `web/src/styles/layout.css`：删除 `#app[data-toolbar='hidden'] #toolbar { display:none }`；`#toolbar` 仍 `position:fixed; top:0`。`#content` 保留一处顶部内边距 `calc(var(--toolbar-height)+16px)` 与 `scroll-padding-top: calc(var(--toolbar-height)+40px)`，未重复叠加。
- 测试：`tests/web/shell-ux.test.js` 原「默认隐藏/800ms 隐藏/菜单推迟隐藏」等用例改为「工具栏始终可见（鼠标、Alt、Esc 都不隐藏）」「最近菜单开关不影响常显」；`tests/web/shell-errors.test.js` 焦点可达性用例改为常显断言；`tests/web/ui-css.test.js` 断言 layout.css 不再含 `data-toolbar`、工具栏 fixed 在顶部且正文只预留一处高度。

## 2. 文档

- `README.md`：使用说明改为「工具栏固定在窗口顶部常显」；分区底板描述增加顶部整宽 chrome 行；快捷键表新增 `Ctrl+A 只选正文`，删除「鼠标移入顶部/Alt 显示、移出自动隐藏」。
- `docs/verify-checklist.md`：§4 增加「右上角 6 DIP 不露白」与「工具栏常显」手测；§5 增加 `Ctrl+A` 只选正文；§6 标题遮挡改为固定工具栏。
- `docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md`：§5.1/§5.2/§5.3 同步固定工具栏与 `Ctrl+A`。

## 3. 测试与构建

本会话沙箱（低完整性 + 禁止子进程管道）导致官方命令无法直接跑通，按以下方式取得证据：

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 前端 `npm test` | **502 passed / 0 skipped**（21 文件） | 在 `%TEMP%` 副本运行；预加载 shim 拦截 Vite 的 `net use` 探测，`--pool=threads` 避开 forks worker 的 `spawn EPERM` |
| 宿主 xUnit | **426 passed / 7 failed**（仅 `IpcTests`） | `dotnet test` 的 testhost 被沙箱拒绝 `OpenProcess`（`Win32Exception(5)`，ASCII 临时路径同样复现），改用反射 runner 逐条执行 Fact/Theory；7 个失败均为命名管道被沙箱禁止，与本次改动无关 |
| 前端产物体积 | **491.0 KB**（内联 CSS 43920 字符） | 官方 `build.ps1` 的 `npm ci`/esbuild 服务因 `spawn EPERM` 失败；在临时副本用 esbuild CLI 等价构建（banner + bundle），产物 ≤ 640 KB |
| `dotnet publish` | 成功 | 临时副本 `out\JingjingReader.exe` |
| `scripts/verify.ps1 -SelfTest` | **21/21 PASS** | 纯函数自测通过 |
| `scripts/verify.ps1`（完整） | **未能完成** | 该脚本依次调用 `npm ci`/esbuild/testhost，均被同一沙箱限制阻断；无法得到 `VERIFY OK` |
| 安装到 `%LOCALAPPDATA%\Programs\JingjingReader` | **失败** | 沙箱拒写 `C:\Users\Admin\AppData\Local\Programs\JingjingReader`（`WebView2Loader.dll` Access denied）；未强行改 ACL |
| 启动应用确认 | **未完成** | 无法覆盖安装目录；从临时目录启动时旧单实例进程与沙箱命名管道限制导致无法完成 renderDone 检查 |

## 4. 已知限制 / 后续

- 工作树中的 `src/Host/Resources/md-engine.js` 是构建产物；由于本会话 Node 进程不能写工作区，未能在工作树内重新生成（临时副本构建已生成 491.0 KB 新产物）。在正常环境运行 `scripts/build.ps1` 会重新生成并覆盖。
- `web/.sandbox-preload.cjs` 是本会话临时测试 shim（未加入 git），正常环境不需要，可删除。
- 需要在正常（非沙箱）环境补跑：`cd web; npm test`、`dotnet test tests/host`、`pwsh -NoProfile -File scripts/build.ps1`、干净克隆 `scripts/verify.ps1` 的 16 项，以及安装/启动烟测。

## 5. Commit

- 已尝试一次 `git add` + 中文 commit；失败于 `.git/index.lock`（Permission denied，沙箱不能写 `.git`）。未强行修复 ACL，全部改动保留在工作树。
- `web/.sandbox-preload.cjs` 为未跟踪的临时测试 shim，不随 commit 提交。
