# 图形卸载器（卸载鲸鲸阅读器.exe）实施与验收报告

- 日期：2026-10-19
- 需求：「安装之后在安装目录下没有卸载软件的可执行文件，加上」
- 基线：`56b8132 fix(ui): 默认白色配色 + 分区底板消除目录栏左侧/底部杂条`（工作树干净后开工）
- 范围：新增 `installer/JingjingReaderUninstall/`；修改 `scripts/uninstall.ps1`、`scripts/build-installer.ps1`、
  `installer/JingjingReaderSetup/`（payload 必需文件、UninstallString）、`tests/installer/`；
  同步 README、spec §8.1、`docs/verify-checklist.md` §19。不改渲染/协议/验收门槛，`scripts/verify.ps1` 16 项不变。
- 本报告与全部改动同属一个中文 commit（提交见 `git log -1`）。

## 1. 设计

### 1.1 新增项目

```text
installer/JingjingReaderUninstall/
├─ JingjingReaderUninstall.csproj  WPF net10.0-windows；框架依赖、PublishSingleFile；AssemblyName=卸载鲸鲸阅读器
├─ app.manifest                    PerMonitorV2 DPI、longPathAware、asInvoker
├─ App.xaml(.cs)                   入口；--silent 无窗口；解析参数/安装目录；静默退出码 0/1/2
├─ MainWindow.xaml(.cs)            确认（卸载/取消）→ 启动进度 → 结果（关闭）；窗口关闭即进程退出
├─ UninstallEngine.cs              校验安装目录 → 复制 uninstall.ps1 到 %TEMP% → 启动 powershell.exe → 立即返回
├─ UninstallLogic.cs               纯逻辑：参数、目录推断/规范化、临时路径、参数拼接、文案（被 tests/installer 链接）
└─ ConsoleOutput.cs                静默模式附着父控制台（UTF-8）
```

- 应用图标复用 `src/Host/app.ico`；输出文件名就是中文 `卸载鲸鲸阅读器.exe`（单文件发布实测 0.62 MB）。
- 确认文案：`确定卸载鲸鲸阅读器？将移除程序与 .md 打开方式；设置/最近/阅读位置会保留。`
- 参数：`--silent`、`--install-dir <目录>`（默认卸载器自身目录）、`--help`。
  静默退出码：`0` = 已成功启动卸载脚本；`1` = 启动失败；`2` = 参数错误。

### 1.2 启动方式与删除时序（A 方案）

按实现约束，**卸载器不等待脚本结束**：

1. 卸载器校验安装目录里存在 `uninstall.ps1` 与 `JingjingReader.exe`；
2. 把 `uninstall.ps1` 复制到 `%TEMP%\jj-uninstall-<guid>\uninstall.ps1`（保留 UTF-8 BOM）；
3. 以 `UseShellExecute=false / CreateNoWindow=true` 启动
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <temp>\uninstall.ps1 -InstallDir "<安装目录>"`，
   工作目录设为临时目录的父目录（不占用安装目录），随后卸载器立即退出；
4. `uninstall.ps1` 从临时目录运行时（目录名 `jj-uninstall-*`）先做关联/注册表/快捷方式清理，再等待卸载器进程退出释放文件锁，
   以 20 × 250 ms（最多 5 秒）重试删除安装目录；成功返回 0 并自清理临时目录，失败保留 `uninstall.log` 并返回非 0。

**退出码语义的取舍（已在协调中确认）**：A 方案下卸载器无法既等待脚本、又让脚本删除正在运行的自身 exe。因此
`--silent` 的退出码只表示「已成功启动脚本」，安装目录删除是异步的；自动化冒烟需轮询目录消失（本报告使用 ≤60 秒）。
图形模式会在启动后显示「卸载已开始」，用户关闭结果窗口后脚本才删除安装目录；最终脚本输出/退出码不进入图形结果页，
失败时保留临时日志供排查。

### 1.3 `uninstall.ps1` 变更

- 新增临时目录检测：仅当脚本位于 `%TEMP%\jj-uninstall-<guid>\` 时启用「等待调用者退出」的删除逻辑；手工从安装目录运行
  时保持原有立即删除语义。
- 新增 `Start-Transcript` 日志：临时目录 `uninstall.log`，成功删除后随临时目录清理，失败保留。
- 删除安装目录：从临时目录运行时删除 `-InstallDir`（而不是 exe 父目录），最多重试 5 秒；仍失败打印原因并 `exit 1`。
- 保留并验证原有清理：`Uninstall\JingjingReader` 键、开始菜单/桌面「鲸鲸阅读器.lnk」、`-KeepFiles`、用户数据保留。
- **脚本必须保存为 UTF-8 BOM**：卸载器用 Windows PowerShell 5.1 启动脚本；无 BOM 的 UTF-8 中文会被 5.1 按 ANSI 误读，
  `Parser` 直接报「字符串缺少终止符」，脚本不执行（本次冒烟首轮即复现，修复后通过）。构建/复制均保留 BOM。

### 1.4 安装器与构建变更

- `SetupLogic` 新增 `UninstallerFileName=卸载鲸鲸阅读器.exe`、`GetUninstallerPath`、`RequiredPayloadFileNames`
  （exe/install.ps1/uninstall.ps1/卸载器/README 五项）。
- `SetupEngine` 解压后按 `RequiredPayloadFileNames` 逐项校验，缺卸载器直接拒绝安装。
- 卸载项：`UninstallString = "<installDir>\卸载鲸鲸阅读器.exe"`，
  `QuietUninstallString = "<installDir>\卸载鲸鲸阅读器.exe" --silent`；`DisplayIcon`/`InstallLocation` 不变。
- `build-installer.ps1`：`build.ps1` 后发布卸载器到 `out\` → 生成含卸载器的 `payload.zip` → 发布安装器到 `dist\`；
  同时把卸载器复制到 `dist\卸载鲸鲸阅读器.exe` 便于查看。`out\` 的五项必需文件与 dist 两个产物都有校验。
- 未创建「开始菜单卸载快捷方式」（需求中的可选项；实际卸载入口为设置→应用与安装目录，避免额外维护一条 .lnk 清理路径）。

## 2. 测试与验收

### 2.1 环境

- Windows 10.0.19045 x64；.NET SDK 10.0.401；Windows PowerShell 5.1.19041.6456；
  可用 PowerShell 7：`C:\Users\Admin\.dsh\profiles\desktop\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe`。
- 冒烟测试机已有真实安装 `D:\software\JJReader` 与 `.md` 用户选择 `JingjingReader.md`。冒烟前用 `reg export` 快照并临时
  清理 ProgID/OpenWith/卸载项/快捷方式，结束后按快照恢复；`JJ_DATA_DIR` 隔离用户数据。UserChoice 未改写。

### 2.2 单测

- `tests/installer`（新增 `UninstallLogicTests` + 更新 `SetupLogicTests`）：
  **89 passed / 0 failed / 0 skipped**（原 67 + 新增 22）。
  工作区 testhost 仍受 `Win32Exception(5)` 限制，测试复制到 `D:\jj-uninstaller-tests`（含 payload.zip）运行。
  覆盖：卸载器参数解析（含 `--install-dir=`、缺值、未知参数、help、后者覆盖前者）、默认安装目录推断、目录规范化/
  拒绝根目录/UNC、临时目录与脚本/日志路径、PowerShell 参数引号、确认/成功/失败文案、安装器 UninstallString/
  QuietUninstallString/GetUninstallerPath/RequiredPayloadFileNames，以及 payload.zip 存在时实际包含 `卸载鲸鲸阅读器.exe`。
- 宿主：干净导出 `D:\jj-host-tests`（`git archive HEAD`）→
  `dotnet test tests/host/JingjingReader.Tests.csproj -c Release` → **432 passed / 0 failed / 0 skipped**。
- 前端：`cd web && npm test -- --run` → **21 files / 498 tests passed / 0 skipped**。

### 2.3 构建

- `scripts/build.ps1`（由 build-installer 调用）→ `BUILD OK out\JingjingReader.exe`。
- `scripts/build-installer.ps1` → `BUILD INSTALLER OK`：
  - `out\卸载鲸鲸阅读器.exe`：**0.62 MB**（单文件、框架依赖）；
  - `payload.zip`：**2.29 MB**（含卸载器；上一版 1.61 MB、无卸载器）；
  - `dist\JingjingReaderSetup.exe`：**2.94 MB**（上一版 2.25 MB）；
  - `dist\卸载鲸鲸阅读器.exe`：**0.62 MB**（构建脚本额外复制的查看副本）。
- payload 实际条目含 `卸载鲸鲸阅读器.exe`（645,365 B），安装器解压后五项必需文件齐全。

### 2.4 图形界面

- 从 `%TEMP%` 副本启动 `卸载鲸鲸阅读器.exe`（无参数）：进程存活、主窗口标题「卸载鲸鲸阅读器」；
  `CloseMainWindow()` 后正常退出，退出码 0。确认窗口/取消/关闭路径无 XAML 资源错误。

### 2.5 冒烟实测（必须项）

脚本：`%TEMP%\jj-uninstaller-smoke\smoke.ps1`（测试用，未入库；使用 Medium 完整性临时目录，避免工作区 Low 标签）。
流程：

1. 复制 `dist\JingjingReaderSetup.exe` 到临时 tools 目录；`reg export` 快照 `.md`、`JingjingReader.md`、
   `FileExts\.md`、`Uninstall\JingjingReader`，并备份开始菜单/桌面快捷方式；临时移除真实 ProgID/OpenWith/卸载项/快捷方式；
2. `JingjingReaderSetup.exe --silent --install-dir <temp>\install --no-shortcuts --no-launch`；
3. 断言安装目录含 `JingjingReader.exe`/`install.ps1`/`uninstall.ps1`/`卸载鲸鲸阅读器.exe`/`README.md`；
   `UninstallString` 与 `QuietUninstallString` 正确；ProgID/OpenWith 注册；
4. `卸载鲸鲸阅读器.exe --silent --install-dir <temp>\install` → 退出码 0；轮询 ≤60 秒；
5. 断言安装目录、ProgID、OpenWith 值、`Uninstall\JingjingReader` 键、开始菜单/桌面快捷方式均消失；
   `.md` 默认值（WorkBuddy.md）与 UserChoice 不变；`%TEMP%\jj-uninstall-*` 临时目录已自清理；
6. `finally` 导入快照、恢复快捷方式并断言 `RESTORE OK`。

结果：**19 PASS / 0 FAIL，`SMOKE OK`，`RESTORE OK`**。卸载脚本日志（成功时随临时目录删除）显示
`JingjingReader.exe --uninstall` 完成；本机 UserChoice 指向本程序，按既有语义只提示重新选择、退出码仍为 0，不视为失败。
测试结束后真实 ProgID/OpenWith/卸载项（`D:\software\JJReader`）与快捷方式已恢复。

### 2.6 自动验收

- `scripts/verify.ps1` 16 项判据未改动；安装器/卸载器不在自动验收内。
- 在干净克隆 `D:\jj-uninstaller-verify` 用 PowerShell 7 运行 `scripts/verify.ps1`：
  **VERIFY OK（16 项：15 PASS + 1 WARN，WARN 为既有端到端 1000 ms 阈值波动）**，报告 `out/verify-report.md`。
- 说明：`verify.ps1` 源文件无 BOM，Windows PowerShell 5.1 会误读中文，继续用 PowerShell 7 运行（沿用既有做法）。

## 3. 限制与后续

- **异步删除**：A 方案下 `--silent` 退出码不表示目录已删；图形结果页也不展示脚本最终输出/退出码。需要更强语义时应改为
  「卸载器自复制到 temp 再等待脚本」，但会偏离本轮确认的「启动即退出」约束，且卸载器自身清理更复杂。
- **框架依赖**：卸载器需要 .NET 10 Desktop Runtime；与安装器/宿主相同。
- **依赖主程序**：安装目录缺少 `JingjingReader.exe` 时卸载器拒绝启动（避免脚本无法还原关联、留下半清理状态），
  可改用 `uninstall.ps1 -KeepFiles`/手动清理。
- **日志已被临时目录自清理**：成功删除后不保留日志；失败时保留 `%TEMP%\jj-uninstall-<guid>\uninstall.log`。
- **未做代码签名**：卸载器同样会触发 SmartScreen；无网络时属正常提示。
- 未创建开始菜单「卸载鲸鲸阅读器」快捷方式（可选项）；卸载入口为设置→应用、安装目录卸载器、`uninstall.ps1`。
- 16 项自动验收、渲染/协议/性能门槛均未改动。

## 4. 需手测项

见 `docs/verify-checklist.md` §19：本报告已自动验证构建、安装/卸载、UninstallString、静默卸载轮询、注册表清理、
临时目录清理、图形窗口启动/关闭；完整 UI 点击流程、DPI、SmartScreen、缺失运行时/权限不足仍列入手测。
