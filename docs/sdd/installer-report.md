# 安装包（JingjingReaderSetup）实施与验收报告

- 日期：2026-10-18
- 需求：「打包成一个安装包，安装的时候自动将 MD 打开方式设置为鲸鲸阅读器」
- 范围：新增 `installer/JingjingReaderSetup/`、`scripts/build-installer.ps1`、`tests/installer/`；
  修改 `scripts/uninstall.ps1`（卸载项/快捷方式清理）；README、spec、手测清单同步；
  不改渲染/分块/协议/验收门槛，不改 `scripts/verify.ps1` 的 16 项判据。
- 本报告与全部改动同属一个中文 commit（提交见 `git log -1`）。

## 1. 设计

### 1.1 为什么是「安装器 + 现有 `--install`」而不是静默改默认应用

Windows 10/11 的 `.md` 默认程序由
`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice`
的哈希保护；第三方程序无法静默写入。项目规范也明确禁止 UserChoice 哈希 hack。因此安装器采用：

1. 安装时调用现有 `JingjingReader.exe --install`：写 `HKCU\Software\Classes\JingjingReader.md` 与
   `.md\OpenWithProgids`；只在「没有有效默认程序」时写 `HKCU\Software\Classes\.md` 默认值。
2. 安装后读取「有效默认」：`UserChoice\ProgId` 优先，回退 `Classes\.md` 默认值。
3. 若仍不是本程序，结果页显示明确提示，并提供「打开「默认应用」设置」按钮（`ms-settings:defaultapps`）；
   用户在 Windows 中确认一次后永久生效。不静默失败，也不伪造哈希。

### 1.2 组件

```text
installer/JingjingReaderSetup/
├─ JingjingReaderSetup.csproj   WPF net10.0-windows；框架依赖、单文件发布；嵌入 payload.zip
├─ app.manifest                 PerMonitorV2 DPI、longPathAware、asInvoker
├─ App.xaml(.cs)                入口；--silent 无窗口安装，UI 模式创建主窗口
├─ MainWindow.xaml(.cs)         安装目录/复选框/进度/结果页；按显示器工作区调整尺寸位置
├─ SetupLogic.cs                纯逻辑：路径校验、快捷方式路径、卸载项键值、payload 条目、
│                               参数解析、有效默认 ProgID、运行时检测（被 tests/installer 直接链接）
├─ SetupEngine.cs               安装引擎：解压→目录切换、--install、快捷方式、卸载项、默认检查
├─ ConsoleOutput.cs             静默模式附着父控制台（UTF-8）
└─ payload.zip                  out\* 压缩（构建产物，git 忽略）
```

### 1.3 安装流程（幂等）

1. **校验安装目录**：展开环境变量、绝对化、去尾分隔符；拒绝盘符根/UNC/非法字符/Windows 目录/
   Program Files/用户数据目录及其祖先；已存在且非空但不是本程序安装目录时拒绝，避免覆盖用户文件。
2. **解压 payload**：先写同级 `<installDir>.staging-<guid>`，校验 `JingjingReader.exe`、`install.ps1`、
   `uninstall.ps1`、`README.md`；再目录切换覆盖。旧目录备份为 `.old-<guid>`，成功删除、失败恢复；
   目标 `JingjingReader.exe` 被占用时提示「请先关闭鲸鲸阅读器」。
3. **注册打开方式**：`<installDir>\JingjingReader.exe --install`，捕获输出与退出码；失败展示退出码/输出，
   但仍写卸载项与快捷方式，保证可卸载（静默退出码非 0）。
4. **快捷方式**：开始菜单总是创建（`SpecialFolder.Programs`）；桌面可选（`SpecialFolder.DesktopDirectory`，
   支持 OneDrive 重定向）；WScript.Shell COM 在独立 STA 线程调用。
5. **卸载项**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\JingjingReader`：
   `DisplayName=鲸鲸阅读器`、`DisplayVersion=0.1.0`、`DisplayIcon=<installDir>\JingjingReader.exe`、
   `Publisher=鲸鲸阅读器`、`InstallLocation`、`UninstallString`/`QuietUninstallString`、
   `NoModify=1`、`NoRepair=1`、`EstimatedSize`。
6. **有效默认检查**：UserChoice 优先、Classes 回退；不是本程序时 `NeedsDefaultAppConfirmation=true`，
   结果页提示 + `ms-settings:defaultapps` 按钮。
7. **静默**：`--silent --install-dir <dir> [--no-shortcuts] [--no-launch]`，退出码 0/1/2；
   UI 模式不自动启动，只提供「打开鲸鲸阅读器」按钮。

### 1.4 UI

- 产品名/版本 0.1.0/`src/Host/app.ico` 图标；安装目录（默认 `%LOCALAPPDATA%\Programs\JingjingReader`）
  + 浏览；关联与桌面快捷方式复选框（默认勾选）；安装/取消；进度文案 + 不确定进度条；
  结果页（打开鲸鲸阅读器 / 打开「默认应用」设置 / 完成）。
- 圆角卡片/按钮，无第三方 UI 依赖。窗口初始 `720×660` DIP，在 `SourceInitialized` 按 Win32
  显示器工作区与 WPF DPI 缩放限制尺寸并居中；高度不足时选项卡片内部滚动。
  （本机 4K/200% 下实测窗口物理 1440×1320，完整可见；200% 的 1080p 小屏会限制到工作区高度。）
- 运行时检查：在标准位置检测 `Microsoft.WindowsDesktop.App 10.x`，缺失时顶部提示并给下载链接；
  完全缺失运行时时由 .NET 宿主给出安装提示。

## 2. 测试证据

### 2.1 环境

- Windows 10.0.19045 x64；.NET SDK 10.0.401；运行时 `Microsoft.WindowsDesktop.App 10.0.12`；
  Windows PowerShell 5.1.19041.6456；4K 显示器、200% 缩放（DPI 192）。
- 本机已有鲸鲸阅读器绿色版安装与 `.md` 关联（`%LOCALAPPDATA%\Programs\JingjingReader`，
  `UserChoice=JingjingReader.md`，Classes 默认值 `WorkBuddy.md`），冒烟用隔离的 `JJ_DATA_DIR`
  并先拍注册表快照，避免破坏真实状态。

> **测试环境限制（重要）**：DSH 工作区中的可执行文件带 Low 完整性标签
> （`whoami /groups`：`Mandatory Label\Low Mandatory Level`），从工作区直接运行安装器/host 无法写
> HKCU 与 `%TEMP%`，会得到 `UnauthorizedAccessException`。因此冒烟把
> `dist\JingjingReaderSetup.exe` 复制到 `%TEMP%\jj-installer-smoke\tools\`（Medium 完整性）后运行；
> `--diagnose` 输出确认临时目录与 HKCU 可写。这是测试沙箱限制，不是安装器缺陷；普通用户从下载/桌面
> 目录运行不受影响。

### 2.2 构建

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1` → `BUILD OK out\JingjingReader.exe`。
- `scripts/build-installer.ps1` → `BUILD INSTALLER OK`：
  - `payload.zip`：**1.61 MB**
  - `dist\JingjingReaderSetup.exe`：**2.25 MB**（框架依赖单文件；WPF 运行时不在包内，因此小于预估 5–8 MB）
- 构建脚本会先跑 `build.ps1`，保证内嵌 `out\` 是最新分发包（含新的 `uninstall.ps1` 与 README）。

### 2.3 单测

- 安装器纯逻辑：`dotnet test tests/installer/JingjingReaderSetup.Tests.csproj` →
  **67 passed / 0 failed / 0 skipped**。
  （工作区 testhost 受 `Win32Exception(5)` 影响，导出到 `D:\jj-installer-tests` 运行；测试项目只链接
  `SetupLogic.cs`，不依赖 WPF/payload。）
- 宿主：干净导出 `D:\jj-check`（`git archive HEAD`）→ `dotnet test tests/host/...` →
  **386 passed / 0 failed / 0 skipped**。
- 前端：`cd web && npm test` → **21 files / 488 tests passed / 0 skipped**。

### 2.4 冒烟（必须实测）

脚本：`smoke-installer.ps1`（测试用，未入库）；日志 115 PASS / 0 FAIL，最终 `SMOKE OK`。
运行方式：`%TEMP%\jj-installer-smoke\tools\JingjingReaderSetup.exe --silent --install-dir <temp>\install --no-shortcuts --no-launch`，
`JJ_DATA_DIR=<temp>\appdata`。

| 阶段 | 覆盖 | 结果 |
| --- | --- | --- |
| 环境 | 安装器副本、`--diagnose`、临时目录/HKCU 写入、无旧卸载项 | PASS |
| 快照 | `.md`、ProgID、`FileExts\.md` 的 reg export + 语义树 | PASS |
| A 干净路径 | 临时移除本机已有 ProgID/OpenWith → 安装（文件/ProgID/OpenWith/卸载项/命令指向安装目录）→ 卸载（安装目录、ProgID、OpenWith、卸载项、备份全部删除）→ 从快照恢复 | PASS |
| B 已有状态 | 覆盖安装两次（幂等、无 staging/old 残留）→ 文件占用失败提示 → 卸载并按备份恢复 | PASS |
| C 快捷方式 | 带快捷方式安装 → 开始菜单/桌面 .lnk 存在且目标/工作目录/图标正确 → 卸载删除快捷方式 | PASS |
| 收尾 | 无残留安装目录/卸载项；真实安装与真实 `assoc-backup.json` 未被改写；最终 `.md` 默认值/UserChoice 与安装前一致 | PASS |

注册表快照（`%TEMP%\jj-installer-smoke\snapshot\`，`reg export`）：

- 安装前：`.md` 默认值 `WorkBuddy.md`；`OpenWithProgids` = `VSCode.md, CodeBuddy CN.md, WorkBuddy.md,
  JingjingReader.md`；`JingjingReader.md` 默认值 `鲸鲸阅读器`，`DefaultIcon`/`shell\open\command` 指向
  `C:\Users\Admin\AppData\Local\Programs\JingjingReader\JingjingReader.exe`；
  `UserChoice\ProgId=JingjingReader.md`；Uninstall 键不存在。
- Phase A 安装后：ProgID、`.md\OpenWithProgids\JingjingReader.md`、卸载项均出现；ProgID 打开命令指向
  临时安装目录；`.md` Classes 默认值仍为 `WorkBuddy.md`，UserChoice 未改。
- Phase A 卸载后：ProgID 键、OpenWith 值、卸载项、关联备份均不存在；`.md` 默认值与 UserChoice 不变；
  再从 `md-before.reg`/`progid-before.reg` 导入后，语义树与安装前完全一致（无 diff）。
- Phase B/C 卸载后：`.md`、`JingjingReader.md`、`FileExts\.md`（含 UserChoice）三棵语义树与安装前
  快照完全一致；卸载项删除；真实安装目录与 `%APPDATA%\JingjingReader\assoc-backup.json`
  （SHA256 前后一致）未被触碰。
- 卸载输出包含 `UserChoice` 提示「请在设置 → 应用 → 默认应用重新选择」（本机 UserChoice 指向本程序，
  属预期，退出码 0）。

### 2.5 额外负向/兼容性测试

- 静默参数错误：`--install-dir` 缺值、未知参数 → 退出码 **2**，输出用法/错误。
- 非法目录：`C:\Windows\JingjingReader` → 退出码 **1**，提示 Windows 系统目录。
- 非空且非本程序安装目录 → 退出码 **1**，提示「不是鲸鲸阅读器安装目录」。
- `uninstall.ps1 -KeepFiles`：10 PASS（保留程序文件与卸载脚本；删除卸载项、关联备份；ProgID 恢复到
  本机原有安装；真实安装未被误删）。
- UI：从 `%TEMP%` 副本启动，窗口标题「鲸鲸阅读器 安装程序」，初始界面完整显示（PrintWindow 截图核对），
  图标/版本/默认目录/两个复选框/安装取消按钮均正确；4K 200% 下窗口完整可见。完整点击流程列入手测清单 §19。

### 2.6 自动验收

- `scripts/verify.ps1` 的 16 项判据未改动；安装器不在自动验收内。
- 在干净导出目录 `D:\jj-installer-verify`（`git archive HEAD` + 本次工作区变更覆盖，不含 out/dist/bin/obj）
  用 PowerShell 7.6.6（`pwsh -NoProfile -File scripts/verify.ps1`）运行：
  **VERIFY OK（16 项：15 PASS + 1 WARN）**，报告 `out/verify-report.md`。关键结果：
  - 验收脚本自测 21/21；构建 exit 0；分发包完整性四项齐全。
  - 宿主单测 386 passed / 0 failed / 0 skipped；前端 21 files / 488 tests passed。
  - full-syntax：`elapsedMs=111`、`tocCount=38`、端到端 1022 ms（WARN，PASS 阈值 <1000、FAIL >2500）。
  - 5 万行：`elapsedMs=187`、`tocCount=500`、exit 0；宿主私有内存峰值 161.8 MB（≤200 MB）。
  - PDF：hello 18787 B；5 万行 2494692 B、1084 页。
  - 双开单实例：第 2 进程 ExitCode=0、进程数 1；前端产物 501730 B 且两份 SHA256 一致。
  - 用户 `%APPDATA%\JingjingReader\recent.json` 未被改写。
- 说明：`verify.ps1` 仓库源文件无 UTF-8 BOM，Windows PowerShell 5.1 会按 ANSI 误读其中文；
  因此本次用 PowerShell 7.6.6 运行（未修改 `verify.ps1` 的 16 项判据）。

## 3. 限制

- **框架依赖**：安装器与程序都依赖 .NET 10 Desktop Runtime。运行时完全缺失时安装器无法启动，
  由 .NET 宿主显示安装提示（这是框架依赖 exe 的固有限制）；安装器界面另检测标准安装位置，缺失时给下载链接。
- **未签名**：会触发 SmartScreen；需要用户点「更多信息 → 仍要运行」。
- **默认应用**：`UserChoice` 哈希保护，程序不能静默设置；安装后需在「默认应用」确认一次。
- **仅当前用户**：只写 HKCU 与用户目录；不支持「为所有用户安装」，拒绝 Program Files（asInvoker）。
- **卸载项清理条件**：`uninstall.ps1` 在 `--uninstall` 成功后才删除卸载项/快捷方式；备份损坏/版本不兼容时
  按既有策略不改注册表并退出非 0，卸载项保留（用户可修复备份后重试）。
- **`-KeepFiles`**：保留程序文件与卸载脚本，但删除卸载项/快捷方式（不再显示为已安装应用）。
- **payload 版本**：`payload.zip` 是构建产物（git 忽略），必须由 `scripts/build-installer.ps1` 生成；
  直接 `dotnet publish installer/...` 会因缺少 `payload.zip` 失败。
- **测试环境**：工作区 Low 完整性标签导致安装器不能从工作区直接写 HKCU/Temp，冒烟从 `%TEMP%` 副本运行；
  这是 DSH 沙箱行为，不影响普通用户。

## 4. 需手测项

见 [docs/verify-checklist.md](../verify-checklist.md) §19「安装包」：完整 UI 点击流程、浏览目录、
开始菜单/桌面快捷方式、设置→应用卸载、默认应用确认、SmartScreen、缺失 .NET 运行时、权限不足等。
本次已自动/脚本验证：构建、静默安装/卸载、重复安装、文件占用错误、快捷方式创建/删除、
卸载项键值、干净路径删除、已有状态恢复、`-KeepFiles`、UI 初始界面。
