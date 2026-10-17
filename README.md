# 鲸鲸阅读器

鲸鲸阅读器是一个 Windows 上的本地 Markdown 阅读器：双击 `.md` 就能在 1 秒内看到排版正确的内容，支持 GFM、笔记体扩展、大纲、主题/排版、阅读位置记忆、PDF 导出与 `.md` 文件关联；纯本地离线，只读、不编辑。

技术形态：极薄的 WPF（.NET 10）宿主承载 WebView2，Markdown 解析、渲染、大纲、主题与阅读交互全部在前端（markdown-it + DOMPurify + 自研 shell）完成。宿主只负责窗口、文件读取、系统对话框、单实例、PDF 打印与注册表关联。

## 功能特性

- **完整 GFM**：标题锚点、表格、任务清单、删除线、自动链接、脚注、emoji、代码高亮（highlight.js，含「复制」按钮）。
- **笔记体与 AI README 常见语法**：YAML front matter（顶部「属性」折叠块）、`[[文件名]]` / `[[文件名|别名]]` 双链（当前文档目录及浅层子目录查找）、`![[文件名]]` 内嵌、`==高亮==`、`%%注释%%`、`[TOC]` 内联目录、`<details>` / `<kbd>` / `<sub>` / `<sup>`、居中 HTML、网络徽章图片离线占位。
- **阅读体验**：可折叠/拖动调宽的大纲侧栏、滚动联动高亮、阅读进度条、回到顶部、三态主题（浅色/深色/跟随系统）、字号 14–24、行距 1.4–2.0、行宽 640/780/960/全宽、中文字体/代码字体。
- **最近文件与位置记忆**：空白启动页显示最近文件；退出重开后回到上次阅读位置；`F5` 重载并保持位置；`Alt+←/→` 在最近文件间切换。
- **文件树**：选择一个文件夹作为浏览根，左栏切换到文件树，点击目录展开、点击文件直接打开；工具条可切回大纲。
- **大文档**：超过 512 KB 自动分块渐进渲染（首屏 256 KB，剩余块滚动进入视口时渲染），超过 20 MB 进入大文件模式（关闭代码高亮与滚动联动并提示）。
- **系统能力**：原生打开文件/文件夹对话框、拖放打开、在资源管理器定位当前文件、单实例（第二次启动把路径转交给已运行窗口）、PDF 导出（A4、12 mm 页边距、深色主题导出浅色底）、`.md` 关联安装/卸载（HKCU；Classes 与打开方式可完整恢复，Windows UserChoice 需用户在默认应用中重新选择）、关于面板。
- **安全**：Markdown 内嵌 HTML 一律经 DOMPurify 白名单清洗；WebView2 关闭开发者工具与浏览器快捷键，WebView 内导航被拦截（外部链接在新窗口/系统浏览器打开），前端消息按应用文档来源校验，内容里的 wikilink/附件只允许打开文档目录内的相对路径。

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / Windows 11，x64（需在 .NET 10 与 WebView2 Runtime 支持范围内） |
| WebView2 | Microsoft Edge WebView2 Runtime（Windows 10/11 通常随 Edge 预装；未安装时从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装 Evergreen Runtime） |
| .NET | .NET 10 Desktop Runtime（默认构建依赖系统运行时）；没有运行时的电脑请用 self-contained 构建 |
| 构建环境 | .NET 10 SDK、Node.js 24 / npm、PowerShell 5.1 或 PowerShell 7 |

## 安装

### 1. 获取程序

从源码构建：

```powershell
pwsh -NoProfile -File scripts/build.ps1
```

产物是 `out\` 目录（`JingjingReader.exe` 及 `WebView2Loader.dll`、`runtimes\` 等运行所需文件），并附带 `install.ps1`、`uninstall.ps1` 与 `README.md`。**分发时请复制整个 `out\` 目录**，不要只复制 exe：WebView2 的原生加载器不是单文件的一部分，安装/卸载脚本也依赖同目录的 exe。

没有安装 .NET 10 运行时的电脑可以用 self-contained 构建（内置运行时，体积约 130–140 MB，首次构建可能需要 NuGet 访问运行时包）：

```powershell
pwsh -NoProfile -File scripts/build.ps1 -SelfContained
# 产物：out-selfcontained\（同样复制整个目录）
```

### 2. 注册 `.md` 打开方式

```powershell
pwsh -NoProfile -File scripts/install.ps1
# 安装后可直接打开 Windows「默认应用」设置页：
pwsh -NoProfile -File scripts/install.ps1 -OpenSettings
```

安装脚本调用 `JingjingReader.exe --install`，只写当前用户的 `HKCU\Software\Classes`（不需要管理员权限）：注册 ProgID `JingjingReader.md` 并把它加入 `.md` 的「打开方式」。如果 `.md` 已有默认程序，Windows 不会允许程序静默抢占，需要到 **设置 → 应用 → 默认应用** 里为 `.md` 选择「鲸鲸阅读器」一次。

脚本默认使用 `out\JingjingReader.exe`（分发包里脚本与 exe 同目录，优先用同目录的 exe）；程序在其它位置时用 `-ExePath <路径>` 指定。

### 3. 直接运行

```powershell
.\out\JingjingReader.exe "D:\资料\笔记.md"
```

## 使用

- 双击 `.md`（完成关联后）或把文件拖进窗口即可阅读；也可以从空白启动页的最近文件列表打开。
- 鼠标移到窗口顶部 40 px 内或按 `Alt` 显示工具条；工具条依次是：打开文件、打开文件夹、返回大纲/当前浏览根、目录、最近、导出 PDF、主题、Aa（排版）、关于。
- 左侧大纲由 `h1–h6` 生成，点击平滑跳转；滚动时当前标题高亮。大纲宽度可拖动（180–360 px），`Ctrl+B` 折叠/展开。
- 点击正文中的 `[[双链]]` 会在当前文档目录及浅层子目录查找同名 `.md`；找不到时顶部提示。
- 深色主题下导出 PDF 会自动使用浅色打印样式，避免黑底打印。
- 程序是单实例的：重复双击文件只会把新文档交给已运行的窗口，不会开第二个进程。

### 快捷键

| 功能 | 快捷键 | 说明 |
| --- | --- | --- |
| 打开文件 | `Ctrl+O` | 原生打开对话框，过滤 `.md/.markdown/.mdown/.txt` |
| 打开文件夹 | `Ctrl+Shift+O` | 选择目录作为文件树浏览根 |
| 大纲开关 | `Ctrl+B` | 折叠/展开左侧大纲 |
| 字号增大 | `Ctrl+=`（或 `Ctrl++`） | 14–24，步进 1 |
| 字号减小 | `Ctrl+-` | 14–24，步进 1 |
| 字号重置 | `Ctrl+0` | 回到 16 |
| 排版面板 | `Ctrl+,` | 字号、行距、行宽、字体 |
| 导出 PDF | `Ctrl+E` | 保存对话框；无文档时提示先打开 |
| 重载 | `F5` | 重新读文件并保持滚动位置 |
| 上一份 / 下一份 | `Alt+←` / `Alt+→` | 按最近文件顺序切换 |
| 主题循环 | `Alt+T` | 浅色 → 深色 → 跟随系统 |
| 关于 | `Alt+A` | 打开关于面板（含 .md 默认应用设置入口） |
| 定位到文件 | `Ctrl+Shift+C` | 在资源管理器中选中当前文件 |
| 显示工具条 | `Alt` | 鼠标移入顶部也会显示；移出后自动隐藏 |
| 关闭浮层 | `Esc` | 关闭排版面板/最近菜单/工具条 |
| 打开文件树中的文件 | 鼠标点击 | 目录点击展开/折叠，文件点击打开 |
| 拖放打开 | 拖入窗口 | `.md` 文件直接打开；文件夹作为浏览根；其它类型提示「不支持的文件类型」 |

## 构建

前置：.NET 10 SDK、Node.js 24 / npm、PowerShell 5.1+（推荐 PowerShell 7）。

```powershell
pwsh -NoProfile -File scripts/build.ps1                # 依赖系统 .NET 运行时 → out\
pwsh -NoProfile -File scripts/build.ps1 -SelfContained # 内置运行时 → out-selfcontained\
```

构建脚本依次执行：`web/` 下 `npm ci` 与 `npm run build`（esbuild → `web/dist/md-engine.js`，体积门禁 500 KB）→ 拷贝到 `src/Host/Resources/md-engine.js` → 清空目标目录 → `dotnet publish`（Release、win-x64、PublishSingleFile）→ 拷入 `install.ps1` / `uninstall.ps1` / `README.md`。自包含构建体积实测约 130–140 MB（首次需要 NuGet 运行时包缓存）。

> PowerShell 版本：构建/验收/安装脚本在 **Windows PowerShell 5.1 与 PowerShell 7 下均可运行**。PowerShell 7 用 `pwsh -NoProfile -File scripts/xxx.ps1`；Windows PowerShell 5.1 用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/xxx.ps1`。推荐 PowerShell 7。

单独跑测试（与 PowerShell 版本无关，在任意终端执行）：

```powershell
cd web; npm test                                      # vitest + jsdom（含 5 万行性能冒烟与产物体积）
dotnet test tests/host/JingjingReader.Tests.csproj    # xUnit
```

数据目录隔离：默认数据目录是 `%APPDATA%\JingjingReader`（WebView2 profile 在其下的 `WebView2\`）。设置 `JJ_DATA_DIR` 环境变量可把 settings/recent/positions/debug.log 与 WebView2 profile 一起改到指定路径（仅显式设置时生效，生产默认路径不变）。`scripts/verify.ps1` 验收时自动把 `JJ_DATA_DIR` 指向 ASCII 临时目录下的 `appdata\`，并校验用户 `%APPDATA%\JingjingReader\recent.json` 未被改写。

## 验收

```powershell
pwsh -NoProfile -File scripts/verify.ps1
# Windows PowerShell 5.1 同样可运行：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本会先跑第 0 步「验收脚本自测」（`-SelfTest` 的 21 例纯函数固定样本，也可单独运行 `pwsh -NoProfile -File scripts/verify.ps1 -SelfTest`），再把 `out\` 复制到纯 ASCII 临时目录（优先 `%TEMP%\jj-verify-<guid>`；若 `%TEMP%` 含非 ASCII 字符，依次回退到 `%LOCALAPPDATA%\Temp`、脚本所在盘根目录下的 `jj-verify-<guid>`；要求纯 ASCII 是「隔离 + 路径含中文时的兼容」：WebView2 子进程在该目录创建用户数据目录，且 `--verify-*` 的命令行/环境变量在非 ASCII 路径上受系统代码页影响），并把 `JJ_DATA_DIR` 指向 `<临时目录>\appdata\`。

随后依次检查（本轮 16 项）：构建、宿主单测（总计 > 0、失败 0、TRX `notExecuted` = 0，跳过会列出）、前端单测（`Test Files` 与 `Tests` 均 > 0、skipped = 0）、运行副本、分发包完整性（exe + install + uninstall + README）、环境自检、`samples/full-syntax.md` 首屏（exit 0、READY 严格校验、≤ 1000 ms、`tocCount` 36–40）、**端到端首屏**（`Process.Start` → stdout READY，含进程启动/WebView2 初始化/文件读取；< 1000 ms PASS、≤ 2500 ms WARN、> 2500 ms FAIL）、`samples/huge-50k-lines.md` 首屏（exit 0、READY 严格校验、≤ 1500 ms、`tocCount ≥ 480`，外层超时 60 s，干净超时重试 1 次）、宿主私有内存峰值（≤ 200 MB，`PrivateMemorySize64` 宿主 50 ms 采样，采样最大间隔 ≤ 250 ms；WebView2 进程组 `WorkingSet64` 每 500 ms 独立采样、只记录、不参与判定）、PDF 导出（hello > 5 KB；5 万行文档 > 1 MB 且页数 > 100）、双开单实例（第 2 个进程 ExitCode = 0 且退出、进程数 = 1）、前端产物 ≤ 500 KB 且两份字节一致、用户 `%APPDATA%\JingjingReader\recent.json` 未被改写。终端打印 `VERIFY OK` / `VERIFY FAILED`，报告写入 `out/verify-report.md`（验收开始会先删旧报告）。

无法自动化的交互项（拖放、对话框、主题、字体、文件树、关联前后注册表一致性、长路径等）见 [docs/verify-checklist.md](docs/verify-checklist.md)；spec §2.3/§9.3 逐条证据与人工项见 [docs/acceptance-traceability.md](docs/acceptance-traceability.md)，本轮执行记录见 [docs/verify-record.md](docs/verify-record.md)。

> 注意 1（内存口径）：按 T17 裁定 2 后的「宿主进程私有内存峰值（`PrivateMemorySize64`，**宿主 50 ms** 采样，最大间隔 ≤ 250 ms）≤ 200 MB」统计；WebView2 进程组（直接子进程与全部后代）的 `WorkingSet64` 由独立 runspace 每 **500 ms** 采样，只作为信息项记录，不参与 PASS/FAIL。上限按实测由原 150 MB 修正为 200 MB（150 MB 保留为优化目标）。本轮（Windows 10.0.19045，WebView2 155.0.4283.60；PowerShell 7.6.6 跑两次、5.1 跑一次）实测：宿主私有峰值 **164.1–175.8 MB**（20–21 个样本，最大间隔 64–66 ms）、WebView2 进程组峰值 **230.1–325.7 MB**（500 ms 采样本轮仅 1–2 个样本）、整树 **343.0–476.7 MB**（同一采样时刻）；数值随采样窗口、WebView2 版本、GPU/系统环境变化，详见 `out/verify-report.md`。
>
> 注意 2（首屏两套口径）：`elapsedMs` 是前端 `renderDone.elapsedMs`（渲染器耗时，full-syntax 本轮 109–112 ms、5 万行 171–177 ms）；「端到端首屏」是 `Process.Start` 到 stdout 出现 READY 的墙钟耗时（含进程启动、WebView2 初始化、文件读取，本轮 1125–1202 ms）。spec §2.3 的 1.0 s 是设计目标（`elapsedMs` 口径），端到端 1.0–2.5 s 记 WARN、不判 FAIL；> 2500 ms 才 FAIL。
>
> 注意 3（descope）：16 ms 滚动帧预算无自动化测量手段，已 descope 为手测（连续滚轮/键盘滚动 5 万行观察掉帧，可选 DevTools Performance），**未自动验证**；TOC > 300 项虚拟滚动同样已 descope（350 项全量渲染是有意行为，测试锁定 < 500 ms）。详见 `progress.md` 与 spec §2.3/§5.3/§10。

## 卸载

```powershell
pwsh -NoProfile -File scripts/uninstall.ps1
# 程序不在 out\ 时：
pwsh -NoProfile -File scripts/uninstall.ps1 -ExePath "D:\apps\JingjingReader\JingjingReader.exe"
```

卸载调用 `JingjingReader.exe --uninstall`：删除本程序写入的 `.md` 打开方式，并按 `%APPDATA%\JingjingReader\assoc-backup.json` 恢复安装前的状态（无需确认提示：脚本直接执行并按结果返回退出码）。**Classes 与「打开方式」可完整恢复；Windows `UserChoice` 由系统保护、程序无法改写**——若 `.md` 的默认应用仍指向鲸鲸阅读器，卸载会明确提示到「设置 → 应用 → 默认应用」重新选择（`ms-settings:defaultapps`），不视为卸载失败。备份缺失时尽力删除本程序写入的键值；备份损坏/版本不兼容时**不改注册表**并报错退出，避免破坏用户原有设置。卸载不会删除阅读偏好、最近文件与 WebView2 缓存；如需彻底清理，手动删除 `%APPDATA%\JingjingReader`（数据目录与 WebView2 profile 都在这里；若曾设置 `JJ_DATA_DIR`，删除对应目录即可）。

## 目录结构

```text
.
├─ src/Host/                 WPF + WebView2 宿主（C#）
│  ├─ App.xaml(.cs)          启动、单实例、--selftest/--verify-*/--install/--uninstall
│  ├─ MainWindow.xaml(.cs)   窗口、WebView2 初始化、md.local 映射、消息通道、拖放
│  ├─ FileHost.cs            编码探测与文本读取（UTF-8/BOM/GB18030/二进制拒绝）
│  ├─ PdfExport.cs           A4/12mm PrintToPdf 导出
│  ├─ Assoc.cs               注册表关联安装/卸载与备份恢复
│  ├─ app.manifest           PerMonitorV2 DPI、长路径、Win10/11 supportedOS
│  ├─ app.ico                占位图标（16/32/48/256）
│  └─ Resources/             内联页面与前端产物 md-engine.js（入库）
├─ web/                      前端源码（markdown-it + DOMPurify + shell）
│  ├─ src/engine.js          Markdown 渲染、标题提取、front matter
│  ├─ src/ext/               双链、高亮、注释、[TOC] 等扩展
│  ├─ src/shell/             工具条、大纲、文件树、最近文件、chrome、快捷键
│  ├─ src/styles/            屏幕样式与打印样式
│  ├─ build.mjs              esbuild 打包 + 500KB 体积门禁
│  └─ dist/                  本地构建产物（git 忽略）
├─ tests/web/                vitest 用例（含 perf.test.js 性能冒烟）
├─ tests/host/               xUnit 用例
├─ samples/                  验收样例：hello.md / full-syntax.md / huge-50k-lines.md
├─ scripts/
│  ├─ build.ps1              构建（-SelfContained 可选；发布前清理并拷入分发文件）
│  ├─ verify.ps1             自动验收 + out/verify-report.md（-SelfTest 只跑脚本自测）
│  ├─ gen-huge-sample.ps1    生成 5 万行样例（UTF-8 BOM 源码，PS 5.1 可解析）
│  ├─ gen-icon.py            生成占位 app.ico（Pillow）
│  ├─ install.ps1            注册 .md 关联
│  └─ uninstall.ps1          注销并恢复
├─ docs/verify-checklist.md  手测清单
├─ docs/acceptance-traceability.md  spec §2.3/§9.3 与自动化证据/人工项对照
├─ docs/verify-record.md     本轮验收记录（人工项未执行）
├─ out/                      构建产物与分发包（git 忽略；含 verify-report.md）
├─ docs/superpowers/         spec 与实施计划（记录，不参与运行）
└─ README.md
```

## 已知限制

- **分块渲染与跨块脚注**：超过 512 KB 的文档按块独立解析，定义在文末的脚注引用在较早的块里会显示为字面文本（`[^1]`）。引用式链接定义已做全文预抽取并补齐，脚注不在补齐范围（脚注区重复会改变既有输出）。这是已知取舍，不是渲染错误。
- **超大文档导出 PDF 会先全量渲染**：导出前会把分块懒渲染的剩余块一次性渲染出来（保证内容完整），因此 5 万行文档导出要约 5 秒、1000+ 页；导出完成后以 toast 提示成功/失败。交互导出的超时保护为「等待 readyToPrint 10 秒 + PrintToPdf 60 秒」（合计最长 70 秒）；`--verify-pdf` 验收命令的外层导出超时为 75 秒。
- **默认关联受 Windows 限制**：安装只写当前用户的「打开方式」，不能静默抢占已有默认程序；`HKCU` 之外的机器级关联不修改，也不需要管理员权限。卸载可完整恢复 `Software\Classes` 与「打开方式」；Windows 的 `UserChoice` 由系统保护，需用户在「默认应用」中重新选择（界面/CLI 会提示 `ms-settings:defaultapps`）。
- **内存主要在 WebView2 内核（Chromium 基线）**：程序会常驻 WebView2 的浏览器/渲染/GPU/工具等进程。本轮验收（Windows 10.0.19045，WebView2 155.0.4283.60；PowerShell 7.6.6 跑两次、5.1 跑一次；宿主 50 ms / WebView2 500 ms 采样）实测：宿主私有内存（`PrivateMemorySize64`）峰值 **164.1–175.8 MB**（20–21 个样本，最大间隔 64–66 ms）、WebView2 进程组（直接子进程与全部后代）`WorkingSet64` 峰值 **230.1–325.7 MB**（1–2 个样本）、整树 `WorkingSet64` 峰值 **343.0–476.7 MB**（同一采样时刻）。验收口径为「宿主进程私有内存峰值 ≤ 200 MB」（150 MB 为后续优化目标），WebView2 进程组单列为信息项、不计入该预算；进程数不作为验收项（WebView2 进程组数量随运行时版本变化，本轮 5 个）。数值受 WebView2 Runtime 版本、GPU、系统环境与采样窗口影响，详见 `out/verify-report.md`。
- **首屏与帧预算**：`elapsedMs`（渲染器口径）本轮 full-syntax 109–112 ms、5 万行 171–177 ms；端到端（`Process.Start` → stdout READY，含 WebView2 初始化）本轮 1125–1202 ms，按 WARN 记录（spec 的 1.0 s 是 `elapsedMs` 口径设计目标）。16 ms 滚动帧预算已 descope，未自动验证；手测方法见 `docs/verify-checklist.md` §16。
- **协议与路径限制**：`openFile` 只接受相对当前文档目录的路径（绝对/UNC/越界/重解析点拒绝）；最近文件走 `openRecent`（只允许 recent.json 命中的路径）、文件树走 `openTreeFile`（只允许浏览根内 Markdown/文本文件）；编码异常/二进制拒绝用 `notice` 持久错误条，空白启动偏好用 `settings` 消息下发。完整消息表见 spec §4.4。
- **图标为占位**：`src/Host/app.ico` 是 `scripts/gen-icon.py` 生成的临时鲸鱼图标（16/32/48/256），正式图标待设计（spec Q1）。
- **不支持**：数学公式 `$...$` / `$$...$$`、Mermaid、定义列表；内嵌 `<script>`/`<style>`/`<iframe>` 会被清洗移除；只读、无编辑、无多标签页、无全文搜索；不做笔记库级双链解析，`[[...]]` 只在当前文档目录及浅层子目录查找。
- **长路径**：清单已声明 `longPathAware`，文件读取对超长路径做 `\\?\` 规范化；网络共享/权限受限目录仍受系统策略约束。

## 许可

本项目目前未附带 `LICENSE` 文件，保留所有权利；如需开源分发，请先与作者确认并补充许可证。第三方依赖及其许可证：markdown-it / markdown-it-footnote / markdown-it-emoji（MIT）、markdown-it-task-lists（ISC）、DOMPurify（MPL-2.0 或 Apache-2.0）、highlight.js（BSD-3-Clause）、esbuild / vitest / jsdom（MIT）、.NET（MIT）、Microsoft Edge WebView2（Microsoft 软件许可条款）。
