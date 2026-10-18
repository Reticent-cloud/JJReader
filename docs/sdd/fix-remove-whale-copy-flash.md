# 修复报告：删除鲸鱼娘主题 + 复制按钮闪烁与「已复制」toast（含关联刷新）

- 基线：`249c37b`（master）
- 范围：仅界面风格、复制反馈与 `.md` 关联后的资源管理器刷新；不改渲染语义、协议与验收门槛（`verify.ps1` 仍为 16 项、产物体积门禁仍为 640 KB）。
- 结论：web 480 / host 386 tests 全通过（0 skipped）；干净克隆 `D:\jj-clean-verify` 全量 `verify.ps1` → **VERIFY OK 16 项（15 PASS + 1 既有 WARN）**。

## 1. 需求

1. 删除 `whale`（鲸鱼娘）界面风格整套，但保留现有鲸鱼女仆娘插画与圆润阅读器风。
2. 代码块复制按钮点击后不再长期高亮：短暂闪烁后恢复，并弹出「已复制」toast；失败时闪失败色并提示「复制失败」。
3. 追加：`--install` / `--uninstall` 成功后调用 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 刷新资源管理器；`install.ps1` 末尾 best-effort 执行 `ie4uinit.exe -show`（失败忽略）；README 补充「图标未刷新时重启资源管理器」。

## 2. 改动明细

### 2.1 删除 whale 主题

| 文件 | 改动 |
| --- | --- |
| `web/src/ui-style.js` | 删除（`UI_STYLES` / 归一化 / `applyUiStyle` / `nextUiStyle` / `uiStyleLabel` 全部移除） |
| `web/src/styles/overrides-whale.css` | 删除（616 行；气泡/水印/渐变背景/鲸尾列表/大圆角等 whale 专属规则） |
| `web/src/mascot.js` | 删除；其中 `MASCOT_SVG` 只被已删除的工具条吉祥物与风格按钮使用，`bubbleDecor` / `MASCOT_LARGE_SVG` 只被已删除的装饰层使用 |
| `web/src/styles/overrides-reader.css` → `overrides.css` | 重命名为单一风格文件；去掉全部 `html[data-ui-style='reader']` 前缀与 whale 重复选择器，规则改为全局生效；合并重复的圆角/插画规则 |
| `web/src/styles/print.css` | 删除 `[data-ui-style]` 双保险选择器、whale 列表符号恢复、`#ui-decor`/`.ui-watermark`/`.toolbar-mascot` 隐藏规则；保留「链接正文色 + 下划线、隐藏代码块顶栏与空状态插画、纯白背景、h1/front matter 去装饰」 |
| `web/src/settings.js` | 去掉 `uiStyle` 默认值、归一化与 `applyUiStyle` 调用 |
| `web/src/index.js` | 去掉 ui-style / mascot SVG / bubbleDecor 的 import 与 `JJ` API；保留 `MASCOT_PHOTO`（空状态插画） |
| `web/src/shell/main.js` | 删除 `applyUiStyleState` 及其全部调用、`#ui-decor` 创建与 append、工具条风格按钮监听与 `uiStyle` patch 分支；删除 `bubbleDecor`/`MASCOT_PHOTO` 装饰层 import |
| `web/src/shell/toolbar.js` | 删除 `ui-style-toggle` 按钮、工具栏左侧吉祥物、Aa 面板「界面风格」下拉及不再使用的 import |
| `src/Host/Resources/index.html` | 删除 `data-ui-style="reader"`；首屏不再预置风格属性（无 reader→whale 切换取舍） |
| `src/Host/Store.cs` | `AppSettings` 删除 `UiStyle` 字段（record 仍以 `MonoFont` 结尾，命名参数调用兼容） |
| `src/Host/SettingsPatch.cs` | 删除 `uiStyle` 合并分支（现为未知字段，忽略） |
| `src/Host/AboutWindow.xaml` | 文案改为「界面风格：圆润阅读器风（鲸鱼女仆娘插画用于图标、关于与空状态）」 |
| `scripts/gen-icon.py`、`web/src/mascot-photo.js` | 注释由「二次元主题背景/空状态」改为「空状态圆形插画」，避免生成脚本再写回旧表述 |

**保留**：`src/Host/app.ico`、`src/Host/AboutMascot.png`、`assets/mascot-source.jpg`、`web/src/mascot-photo.js` 与空状态圆形插画、关于面板插画、`scripts/gen-icon.py`、640 KB 体积门禁、圆润阅读器风样式。

**旧 settings.json 兼容**：`System.Text.Json` 默认忽略未知字段，`Store.LoadSettings` 遇到带 `uiStyle` 的旧文件仍正常读取；新增 `StoreTests.LoadSettings_ignores_legacy_ui_style_field` 锁定该行为，`SettingsPatchTests.Apply_ignores_legacy_ui_style_field` 锁定旧 patch 不参与合并。

### 2.2 复制按钮：闪一下 + toast

- `web/src/enhance.js`：
  - 新增 `COPY_FEEDBACK_MS = 260` 与按钮级 `WeakMap` 计时器；
  - 成功写 `data-copied='1'`、失败写 `data-failed='1'`（互斥），260 ms 后自动删除两个属性；同一按钮重复点击先 `clearTimeout` 再重新计时；
  - 无论成功/失败都 `document.dispatchEvent(new CustomEvent('jj:copy', { detail: { ok } }))`。
- `web/src/shell/main.js`：新增 `onCopyResult` 监听 `jj:copy`，调用 `showToast(ok ? '已复制' : '复制失败', ok ? 'info' : 'warn')`；`destroy()` 中移除监听。
- `web/src/styles/code.css`：`[data-copied]` / `[data-failed]` 保持现有成功/失败色，新增 `color .12s`、`border-color .12s` 过渡；属性 260 ms 后移除，按钮不会常驻高亮（`:focus-visible` 仍是键盘可达性样式，鼠标点击不触发）。
- 测试：新增 `tests/web/copy-button.test.js`（5 例，fake timers）覆盖成功/失败属性与事件、260 ms 后清除、重复点击重置计时器、shell `#toast` 文本「已复制」/「复制失败」；`tests/web/ui-css.test.js` 增加脚本常量与 CSS 闪烁/过渡文本断言。

### 2.3 关联刷新（追加需求）

- 新增 `src/Host/ShellNotify.cs`：`SHChangeNotify(0x08000000 /* SHCNE_ASSOCCHANGED */, 0x0000, IntPtr.Zero, IntPtr.Zero)`；任何异常吞掉并返回 false，绝不向上抛。
- `src/Host/App.xaml.cs`：`RunAssociationCommand` 在 install 成功、uninstall 成功（含 UserChoice 警告路径）后调用 `NotifyAssociationsChanged()`；失败只记 `debug.log`，不改变退出码。
- `scripts/install.ps1`：在 `--install` 成功并打印提示后，best-effort 调 `ie4uinit.exe -show`（找不到/失败静默忽略）；UTF-8 BOM 保留，PowerShell 5.1 可正确读取中文。
- `README.md` 安装/卸载两节补充 `SHChangeNotify`、`ie4uinit.exe -show` 与「图标未刷新时重启资源管理器」；`docs/verify-checklist.md` §10 增加手测项。
- 测试：`tests/host/ShellNotifyTests.cs` 断言调用不向上抛（通知是 best-effort）。

### 2.4 测试与文档同步

- 删除 `tests/web/ui-style.test.js`（12 例）。
- `tests/web/ui-css.test.js` 重写为单一风格断言：whale 文件/脚本/测试不存在、无 `data-ui-style` 残留、`overrides.css` 存在且无 `--whale-*`、打印链接/h1/front matter/通知条规则、active 对比度、复制按钮 260 ms 闪烁、`app.ico`/`AboutMascot.png`/`mascot-source.jpg`/空状态 data URI 仍存在。
- 宿主测试：删除 `SettingsPatchTests` 的 uiStyle 合并用例与 3 条类型不符样本、`StoreTests` 的 uiStyle 往返用例；新增两条旧 `uiStyle` 兼容用例；`ProtocolTests` / `ProtocolNoticeTests` 删除 `uiStyle` 字段断言并反向断言 settings 消息不再携带该字段。
- `README.md`：功能特性、工具条顺序、界面风格章节、快捷键表、目录结构、已知限制同步为「单一界面风格：圆润阅读器风 + 鲸鱼女仆娘插画（图标/关于/空状态）」；删除 `ui-style.js` 行与首屏 reader→whale 已知取舍。
- `docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md`：§5.2 删除「界面风格」快捷键行；§5.4 改写为单一风格；§10 体积说明去掉「二次元主题」。
- `docs/verify-checklist.md`：§18 改写为单一风格 + 复制按钮手测；§10 增加关联图标刷新项。
- `docs/acceptance-traceability.md` / `docs/verify-record.md` 经检索无 uiStyle/whale/界面风格条目，无需修改；`docs/sdd/` 下历史报告（ui-wave-report、sdd-ledger 等）保持原样，未改动。

## 3. 验证

### 3.1 单元测试

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 前端 | `cd web && npm test` | **21 files / 480 tests passed，0 skipped**（基线 489；删除 ui-style 12 例、新增 copy-button 5 例、ui-css 重写） |
| 宿主 | `dotnet test tests/host/JingjingReader.Tests.csproj`（干净副本 `D:\jj-check`） | **386 passed / 0 failed / 0 skipped**（基线 388；+3 新用例，-5 旧 uiStyle 用例） |
| 构建 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1` | BUILD OK；`md-engine.js` 485.9 KB（工作区 LF 497511 B；干净克隆 CRLF 498471 B，均 ≤ 640 KB） |

> 主仓库内直接 `dotnet test` 仍因本会话沙箱无法打开父进程句柄报 `Win32Exception (5)`（环境限制，非代码失败）；按约定将工作树导出到 ASCII 路径 `D:\jj-check` 后 386/386 通过。

### 3.2 全量验收（干净克隆）

- 目录：`D:\jj-clean-verify`（`git clone` 自本提交的代码树；报告文件本身不参与构建/测试）
- 命令：`pwsh -NoProfile -File scripts/verify.ps1`（PowerShell 7.6.6 Core）
- 结果：**VERIFY OK**，共 16 项（15 PASS + 1 WARN）：

| 项目 | 结果 |
| --- | --- |
| 验收脚本自测 | 21/21 PASS |
| 构建 / 分发包完整性 | PASS |
| 宿主单测 | 386/386，0 skipped，PASS |
| 前端单测 | 21 files / 480 tests，0 skipped，PASS |
| full-syntax 首屏 | `elapsedMs=133`（≤1000），`tocCount=38`（36–40）PASS |
| 端到端首屏 | 1383 ms（WARN，<1000 PASS / ≤2500 WARN） |
| 5 万行首屏 | `elapsedMs=220`（≤1500），`tocCount=500`（≥480）PASS |
| 宿主私有内存峰值 | 161.7 MB（≤200 MB；25 个样本，最大间隔 64 ms）PASS |
| PDF hello | 18787 B（>5 KB）PASS |
| PDF 5 万行 | 2340282 B（>1 MB）、1084 页（>100）PASS |
| 双开单实例 | 第 2 进程 ExitCode=0，3 s 后仅 1 个进程 PASS |
| 前端产物体积 | dist=498471 B、Resources=498471 B，SHA256 一致，≤655360 PASS |
| 用户数据目录 | `%APPDATA%\JingjingReader\recent.json` 前后哈希一致 PASS |

## 4. Concerns / 未自动覆盖

1. **实际 `--install`/`--uninstall` 未在验收中执行**：验收脚本按设计不写注册表；`SHChangeNotify` 的成功路径只做了编译与「调用不抛异常」单测，未在实际 HKCU 关联变更后肉眼确认资源管理器图标刷新。`ie4uinit.exe -show` 同样只做脚本语法解析与 best-effort 逻辑，未在安装流程中实跑。
2. **视觉闪烁为文本级 + 定时器断言**：jsdom 无真实渲染，260 ms 闪烁观感需按 `docs/verify-checklist.md` §18 手测确认。
3. **删除 `mascot.js` 的判断**：其内联 SVG 只服务已删除的工具条吉祥物/风格按钮与装饰层；保留了用户插画资产（`app.ico`、`AboutMascot.png`、`mascot-photo.js`、`assets/mascot-source.jpg`），未删除任何图标/插画文件。
4. **历史报告**：`docs/sdd/ui-wave-report.md`、`sdd-ledger.md` 等历史记录保持原样（其中仍会提到当时的 reader/whale 双风格），属于历史事实，不随本次删除回改。
