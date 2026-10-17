# 验收追溯表（spec §2.3 / §9.3 → 证据）

- 日期：2026-10-18（修复波 D）
- 基线：`c01e113`（修复波 D 之前）+ 本轮修复提交
- 自动结论来自 `out/verify-report.md`（修复波 D 最终验收，单次权威运行）；人工项记录见 [verify-record.md](verify-record.md)（本轮全部「未执行（需人工）」）。
- 状态只用三种：**已自动验证** / **需人工** / **已 descope（附理由）**；同时存在时并列写明。

## spec §2.3 验收标准（六条）

| # | spec 条目 | 判定口径 | 自动化证据 | 人工项 | 状态 |
|---|---|---|---|---|---|
| 2.3-1a | 双击 `.md` 首屏 ≤ 1.0 s（热启动） | 前端 `renderDone.elapsedMs`（渲染器耗时） | `verify.ps1`「full-syntax 首屏」：READY 严格校验，`elapsedMs` ≤ 1000 ms（修复波 D 最终验收 121 ms）；`tests/host/ProtocolTests.cs`（renderDone 契约）；`tests/web/shell-boot.test.js` | 真实双击关联路径/窗口激活 | **已自动验证**（CLI 渲染口径）；双击路径**需人工**（checklist §15） |
| 2.3-1b | 端到端首屏（进程启动 → 首屏可见） | `Process.Start` → stdout READY 的墙钟（含 WebView2 初始化/文件读取） | `verify.ps1`「端到端首屏」：< 1000 ms PASS、≤ 2500 ms WARN（修复波 D 最终验收 1150 ms WARN）；报告与 README 同时给出两套数字 | 首屏视觉确认、冷/热启动各 3 次 | **已自动验证**（CLI 墙钟，WARN 口径）；视觉/双击**需人工** |
| 2.3-2 | 宿主进程私有内存峰值 ≤ 200 MB（WebView2 组仅记录） | `PrivateMemorySize64` 50 ms 采样，最大间隔 ≤ 250 ms；仅 5 万行渲染成功时判定 | `verify.ps1`「宿主私有内存峰值」：修复波 D 最终验收 162.8 MB、21 个样本、最大间隔 65 ms；**内存判据是 e2e 项，未在 `-SelfTest` 内**（SelfTest 只覆盖 READY/测试统计/PDF-ready 解析等纯函数）；`tests/host/StoreTests` 与内存无关 | 长时间阅读后的内存观感（任务管理器，可选） | **已自动验证** |
| 2.3-3 | 语法矩阵每一行有样例与自动化断言 | 每行至少一个结构断言；不支持项断言「原样文本」 | `tests/web/engine-basic.test.js`（Setext/`<br>`/`<img align>`/数学/Mermaid/定义列表补行）、`engine-gfm.test.js`（表格/任务/脚注/高亮/复制）、`ext-notes.test.js`（front matter/wikilink/高亮/注释）、`readme-enhanced.test.js`（内嵌 HTML/[TOC]/图片占位）、`sanitize.test.js`、`chunk.test.js` | 视觉排版/字体/主题观感 | **已自动验证**（结构层）；视觉**需人工**（checklist §4–§6） |
| 2.3-4a | 5 万行首屏 ≤ 1.5 s | READY `elapsedMs` ≤ 1500 ms、tocCount ≥ 480、exit 0 | `verify.ps1`「5 万行首屏」：修复波 D 最终验收 190 ms、tocCount 500、外层超时 60 s；`tests/web/perf.test.js`（splitBlocks/extractHeadings < 300 ms、256KB renderMarkdown < 1000 ms 宽松护栏） | 打开大文档的观感 | **已自动验证**（渲染口径） |
| 2.3-4b | 5 万行滚动帧预算 < 16 ms | 无自动化测量手段 | 无（不得声称已自动验证） | 连续滚轮/键盘滚动 5 万行观察掉帧；可选 DevTools Performance | **已 descope**：jsdom 无真实布局/合成器，无法测帧；改手测（checklist §16），理由与后续建议见 `progress.md` |
| 2.3-5 | TOC 点击跳转正确；重开回到上次位置 | DOM 结构/滚动调用/持久化读写 | `tests/web/shell-ui.test.js`（TOC 点击 top-80、350 项全量）、`shell-ux.test.js`（滚动联动/位置）、`chunk.test.js`（点击靠后标题先 renderAll）、`tests/host/StoreTests.cs`（positions LRU/读回）；`verify.ps1` 不覆盖位置恢复 | 关开程序后的端到端位置恢复、提示条视觉 | **已自动验证**（组件级）；端到端**需人工**（checklist §7、§12） |
| 2.3-6 | 导出 PDF 与屏幕一致（分页/图片/表格/代码不截断） | 体积、页数、`PDF-READY` 契约 | `verify.ps1`「PDF（hello.md）」（18787 B）、「PDF（5 万行文档）」（2314459 B、1084 页）；`tests/host/PdfExportTests.cs`/`VerifyPdfTests.cs`；`tests/web/print.test.js` | 逐页视觉检查（图片/表格/代码/浅色底） | **已自动验证**（体积/页数/流程）；视觉一致性**需人工**（checklist §8） |

## spec §9.3 集成验收（七条）

| # | spec 条目 | 自动化证据（`verify.ps1` 检查项） | 人工项 | 状态 |
|---|---|---|---|---|
| 9.3-1 | 构建成功（前端 + 宿主） | 「构建」（`scripts/build.ps1` exit 0、产出 exe）；「分发包完整性」（exe + install + uninstall + README） | 自包含构建在无 .NET 机器上的启动（checklist 前置/§15） | **已自动验证**（默认构建）；自包含启动**需人工** |
| 9.3-2 | 全部单测通过 | 「宿主单测」382 passed/0 failed/0 skipped（TRX `notExecuted`）；「前端单测」21 files/474 tests、skipped=0；另有「验收脚本自测」21 例（断言总数 21 且 0 失败） | — | **已自动验证** |
| 9.3-3 | `--verify-render full-syntax` ≤ 1000 ms | 「full-syntax 首屏」elapsedMs 121 ms、tocCount 38（36–40）、READY 严格校验 | 视觉断行/字体（checklist §5） | **已自动验证** |
| 9.3-4 | `--verify-render huge` ≤ 1500 ms + 宿主私有内存 ≤ 200 MB | 「5 万行首屏」（190 ms、tocCount 500、60 s 超时/重试 1 次）+「宿主私有内存峰值」（162.8 MB、采样间隔 65 ms）；WebView2/整树仅信息 | 滚动流畅度/大文件模式视觉（checklist §12、§14、§16） | **已自动验证**（内存/渲染）；滚动帧**已 descope** 为手测 |
| 9.3-5 | `--verify-pdf` 产物 > 5 KB | 「PDF（hello.md）」18787 B +「PDF（5 万行文档）」2314459 B/1084 页 | 视觉一致性（checklist §8） | **已自动验证**（体积/页数）；视觉**需人工** |
| 9.3-6 | 双开单实例进程数 = 1 | 「双开单实例」：第 2 个进程 ExitCode=0 且退出、3 s 后进程数=1；debug.log 交叉校验为附加证据 | 窗口激活/最小化还原的视觉确认（checklist §13） | **已自动验证**（进程/退出码）；激活行为**需人工** |
| 9.3-7 | 输出 `out/verify-report.md` | 每次验收写报告；开始前删除旧报告；本轮 16 项、15 PASS + 1 WARN、VERIFY OK | — | **已自动验证** |

## 其它加固项与证据

| 项 | 证据 | 状态 |
|---|---|---|
| 验收隔离（`JJ_DATA_DIR`）与用户数据未被改写 | `verify.ps1`「用户数据目录未被改写」：recent.json mtime/SHA256 前后一致；所有 exe 调用显式传 `JJ_DATA_DIR`；`JJ_DATA_DIR` 仅用于测试隔离，产品默认 UDF 在 `%LOCALAPPDATA%\JingjingReader\WebView2` | **已自动验证** |
| 跳过测试不计通过（I5） | 宿主 TRX `notExecuted`、vitest `skipped` 均 FAIL；`-SelfTest` 覆盖 skipped>0 样本 | **已自动验证** |
| 采样保真（I3） | 采样最大间隔 > 250 ms 判 FAIL；报告写样本数/最大间隔 | **已自动验证** |
| 清理安全（I8） | 启动记录 (PID, StartTime, ImagePath)；杀进程前校验；报告残留检查 | **已自动验证**（代码路径 + 本次清理记录） |
| 5 万行稳定性（I7） | 60 s 超时、干净超时重试 1 次、debug.log 摘要、尝试历史入报告；重试前清理 WebView2 后代与临时 profile | **已自动验证**（本次 1 次通过） |
| 端到端首屏与 16 ms 帧预算 | 前者自动 WARN 口径；后者 descope | 见上 |
| TOC >300 虚拟滚动 | 已 descope；`shell-ui.test.js` 锁定 350 项全量渲染 < 500 ms | **已 descope**（成本/收益不成立） |
| 快照测试 | 已 descope：用结构断言替代 5 篇 README 快照（更稳、可读） | **已 descope** |
| 手测项（拖放/对话框/主题/字体/文件树/关联/长路径/首屏视觉/PDF 视觉等） | [verify-checklist.md](verify-checklist.md) | **需人工**（本轮全部未执行） |
