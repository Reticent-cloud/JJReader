# 鲸鲸阅读器验收记录（修复波 C，historical）

> 指针：自动验收的权威数字以**最终验收（@0af4231，`out/verify-report.md`）**为准。本文件保留修复波 C 三次运行的历史记录（下文统一标 `historical`），不随后续修复波改写；开头一节只是把最终报告的值抄录过来便于对照。

- 日期：2026-10-18
- 分支：`feat/jingjing-reader`
- 基线：`47669b2`（修复波 B 完成）；最终验收为 `013cbe1` → `0af4231`
- 结论：自动化验收 **VERIFY OK**（16 项：15 PASS + 1 WARN，0 FAIL）；**人工项截至最终验收仍全部未执行（需人工）**。

## 最终口径（最终验收 @0af4231，单次权威运行）

> 本节逐项抄自 `out/verify-report.md`（`feat/jingjing-reader @ 0af4231（工作树 干净）`，生成于 2026-10-18 05:14:04 +08:00，耗时 37.2 s；宿主 50 ms / WebView2 500 ms 采样；运行副本为纯 ASCII 临时目录，数据目录与 WebView2 profile 由 `JJ_DATA_DIR` 隔离）。

| 检查项 | 实测 | 结果 |
|---|---|---|
| 验收脚本自测（`-SelfTest`） | 21 例固定样本（期望 21），0 例失败 | PASS |
| 构建 | exit 0，`out\JingjingReader.exe` | PASS |
| 宿主单测 | 382 passed / 0 failed / 0 skipped（TRX） | PASS |
| 前端单测 | 21 files / 488 tests / 0 skipped | PASS |
| ASCII 运行副本 | exe 1.7 MB，数据目录 `<temp>\appdata` | PASS |
| 分发包完整性 | exe + install.ps1 + uninstall.ps1 + README.md | PASS |
| 环境自检 | 产品名=鲸鲸阅读器（.NET 10.0.12 / WebView2 155.0.4283.60 / PowerShell 7.6.6 Core） | PASS |
| full-syntax 首屏 | `elapsedMs`=113 ms、tocCount=38（36–40） | PASS |
| 端到端首屏 | `Process.Start` → READY 1029 ms | **WARN**（< 1000 PASS / ≤ 2500 WARN） |
| 5 万行首屏 | `elapsedMs`=185 ms、tocCount=500（≥480）、尝试 1 次 | PASS |
| 宿主私有内存峰值 | 174.3 MB（19 个样本，最大间隔 64 ms，≤ 200 MB） | PASS |
| PDF（hello.md） | 18787 B | PASS |
| PDF（5 万行文档） | 2314459 B、1084 页 | PASS |
| 双开单实例 | 第 2 进程 ExitCode=0 且退出；进程数=1 | PASS |
| 前端产物体积 | 475324 B × 2（`web/dist` 与 `src/Host/Resources`），SHA256 一致 | PASS |
| 用户数据目录未被改写 | recent.json 3697 B，mtime/SHA256 前后一致 | PASS |

信息项（不参与判定）：WebView2 进程组 `WorkingSet64` 峰值 235.7 MB（6 个 `msedgewebview2` 进程，500 ms 采样 1 次）；
整树 `WorkingSet64` 峰值 349.8 MB（同一采样时刻）。完整数据见 `out/verify-report.md`。

## 历史（historical）：修复波 C 三次运行

以下为修复波 C 当时（PowerShell 7.6.6 跑两次、Windows PowerShell 5.1.19041.6456 跑一次，均 VERIFY OK）的实测范围，
仅作历史保存，**不再作为当前结论**；当前数字见上一节。

| 检查项 | 波 C 实测（historical） | 结果 |
|---|---|---|
| 验收脚本自测（`-SelfTest` 21 例） | 21 / 21（两版本） | PASS |
| 构建 | exit 0，`out\JingjingReader.exe` | PASS |
| 宿主单测 | 376 passed（波 C 当时 371） | PASS |
| 前端单测 | 21 files / 474 tests（波 C 当时 19 files / 447 tests） | PASS |
| ASCII 运行副本 | 1.6 MB，数据目录 `<temp>\appdata` | PASS |
| 分发包完整性 | exe + install.ps1 + uninstall.ps1 + README.md | PASS |
| 环境自检 | 产品名=鲸鲸阅读器 | PASS |
| full-syntax 首屏 | `elapsedMs`=109–112 ms、tocCount=38 | PASS |
| 端到端首屏 | 1125–1202 ms | **WARN** |
| 5 万行首屏 | `elapsedMs`=171–177 ms、tocCount=500、尝试 1 次 | PASS |
| 宿主私有内存峰值 | 164.1–175.8 MB（20–21 样本，最大间隔 64–66 ms） | PASS |
| PDF（hello.md） | 18791 B | PASS |
| PDF（5 万行文档） | 1977619 B、1042 页 | PASS |
| 双开单实例 | 第 2 进程 ExitCode=0 且退出；进程数=1 | PASS |
| 前端产物体积 | 435762 B × 2，SHA256 一致 | PASS |
| 用户数据目录未被改写 | recent.json mtime/SHA256 前后一致 | PASS |

历史信息项（不参与判定）：WebView2 进程组 `WorkingSet64` 峰值 230.1–325.7 MB（5 个进程，500 ms 采样 1–2 个）；
整树 `WorkingSet64` 峰值 343.0–476.7 MB（同一采样时刻）。

历史环境：Windows 10.0.19045.0（x64）、.NET 10.0.12、WebView2 Runtime 155.0.4283.60；Node / npm 为仓库
`web/package-lock.json` 锁定版本（`npm ci`）；构建与验收同一台本机（热缓存）。

历史分发包：`out\` 2.8 MB（11 个文件）、`out-selfcontained\` 135.8 MB（15 个文件），二者均含
`JingjingReader.exe` + `install.ps1` + `uninstall.ps1` + `README.md`；exe 的 ProductName/FileDescription
均为「鲸鲸阅读器」、版本 0.1.0.0（波 C 实测，未写入最终报告）。自包含产物**未在未安装 .NET 10 运行时的机器上启动**（需人工，见 checklist 前置）。

历史自测命令（两版本均 21/21）：
`pwsh -NoProfile -File scripts/verify.ps1 -SelfTest`；`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -SelfTest`。

## 人工项（截至最终验收仍未执行）

以下各项**均未执行**，不得视为已验证；执行方法见 [verify-checklist.md](verify-checklist.md)。

| # | 人工项 | 状态 |
|---|---|---|
| 1 | 拖放：`.md` / 文件夹 / 非 Markdown / 多文件 / 光标 | 未执行（需人工） |
| 2 | 打开文件/文件夹对话框（`Ctrl+O` / `Ctrl+Shift+O`、工具条按钮、取消） | 未执行（需人工） |
| 3 | 文件树：排序、惰性展开/折叠、重试、高亮、空目录、不可读目录 | 未执行（需人工） |
| 4 | 主题三态与跟随系统、切换白闪、重启保持 | 未执行（需人工） |
| 5 | 排版：字号/行距/行宽/字体、窄窗口、重启保持 | 未执行（需人工） |
| 6 | 大纲：38/500 标题、点击定位、滚动联动、拖宽、折叠保持 | 未执行（需人工） |
| 7 | 最近文件/位置记忆/F5/`Alt+←→`/`Ctrl+Shift+C` | 未执行（需人工） |
| 8 | 深色主题导出 PDF 的逐页视觉检查 | 未执行（需人工） |
| 9 | 关于面板、默认应用入口、复制诊断信息 | 未执行（需人工） |
| 10 | `.md` 关联安装/卸载前后注册表一致性、UserChoice 提示、损坏备份保护 | 未执行（需人工） |
| 11 | 长路径（> 255）打开/树/导出 | 未执行（需人工） |
| 12 | 5 万行滚动、位置恢复、大文件模式提示 | 未执行（需人工） |
| 13 | 双开单实例的窗口激活/最小化还原（进程数已自动验证） | 未执行（需人工） |
| 14 | 首屏视觉/冷热启动各 3 次；版本信息与图标 | 未执行（需人工） |
| 15 | 16 ms 帧预算手测（滚轮/键盘/DevTools Performance） | 未执行（需人工，descope 项） |
| 16 | 长 TOC（350 项）全量渲染的交互观感 | 未执行（需人工，descope 项） |

## 已知 descope（不随后续修复波改变，理由与后续建议见 `progress.md`）

1. **16 ms 滚动帧预算**：无法自动化测量（jsdom 无真实布局/合成器）；改手测，未验证。
2. **TOC > 300 项虚拟滚动**：成本/收益不成立；350 项全量渲染实测 < 500 ms（测试锁定），保留为后续优化项。
3. **快照测试**：用结构断言替代 5 篇 README 快照，避免脆弱快照；覆盖等价性由矩阵/集成用例保证。
4. **手测项**：截至最终验收全部未执行；合并前应由人工按 `verify-checklist.md` 完成并回填本记录。

## 复现命令

```powershell
# PowerShell 7（推荐）
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/verify.ps1 -SelfTest
# Windows PowerShell 5.1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -SelfTest
```
