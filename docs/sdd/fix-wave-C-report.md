# 修复波 C 报告（测试加固 / 验收 / 打包 / 文档）

- 日期：2026-10-18
- 分支：`feat/jingjing-reader`
- 基线：`47669b2`（波 A `f8207f4`、波 B `47669b2`）
- 本轮提交：`feccf1a`（单条中文 commit，未改写历史）
- 结论：**完成**。host 371 tests / web 447 tests 全绿；`scripts/verify.ps1` **VERIFY OK**（16 项：15 PASS + 1 WARN + 0 FAIL）；`-SelfTest` 21/21（PS 7 与 PS 5.1 均通过）；自包含构建 135.8 MB 且分发包完整。

## A. 测试加固

| # | 项 | 改法 | 结果 |
|---|---|---|---|
| 1 | reparse 用例真实执行 | `DirectoryListerTests` 先用 `cmd /c mklink /J` 建目录 junction（普通用户可用），失败回退 `Directory.CreateSymbolicLink`，两者都不可用则 `Assert.Fail("环境不支持创建 junction/symlink，无法验证 reparse 限制")`；断言根内 junction 条目被跳过、`List(root,"link")` / `link\sub` 抛 `UnauthorizedAccessException` | 真实执行并通过（无 skip） |
| 2 | IPC 换行真实执行 | 启动真实 `IpcServer`（随机 pipe），发送 `"C:\\a\nb.md"`（3s 超时）→ 返回 false、100 ms 后 `received == 0`；随后合法路径仍送达且仅 1 条 | 通过 |
| 3 | chunk 两处空转 | 追加内容用例：先记录标题数/子节点数/文本长度 → 循环触发 observer 直到哨兵消失 → 断言三项增长、出现 `END-MARKER`、h2 顺序完整；非目录锚点用例去掉 `if (anchor)`，先 `expect(anchor).toBeTruthy()` 再点击 | 通过（用例 1239 ms，可接受） |
| 4 | Store 原子写失败路径 | `Store.Save<T>` 加 try/finally 删除 `.tmp`；新增用例用 `FileShare.None` 独占目标 → `SaveSettings` 抛 `IOException/UnauthorizedAccessException`，目标字节不变、重读仍是旧值、`.tmp` 已清理 | 通过（371 项中的新用例） |
| 5 | sanitize 混淆变体 | 表驱动覆盖 `JaVaScRiPt:`、实体/字面 tab/NUL、`EXPRESSION(`、`BACKGROUND:URL(javascript:)`、`vb&#x53;cript:`；显式锁定协议相对 `//host/x` 允许、前导空白 href、`data:image/svg+xml` 允许（`allowDataImages=false` 时移除）；导出并直接单测 `isSafeUrl` / `URL_WHITESPACE_RE`（19 组 URL + 空白字符集） | 通过（sanitize 73 tests） |
| 6 | 矩阵补行 + 首块渲染计时 | `engine-basic.test.js` 新增 Setext、`<br>`、`<img align>`、`$..$` / Mermaid / 定义列表「原样文本」断言；`perf.test.js` 新增前 256KB `renderMarkdown` < 1000 ms（注明非预算门禁） | 通过 |
| 7 | TOC >300 裁定 | 不实现虚拟滚动（成本/收益不成立），在 spec §5.3、README、ledger 记录 descope；`shell-ui.test.js` 用例改名为「全量渲染是有意行为」并保留 < 500 ms 速度断言 | 通过（58 tests） |
| 8 | 测试卫生 | readme-enhanced / shell-boot / engine-gfm / sanitize 增加 `mounted` 数组与 `afterEach` destroy；`shell-ui.test.js` afterEach 补 `vi.useRealTimers()`；ext-notes 无 mountShell（不适用） | 通过 |

## B. 验收脚本（I2–I8 + 小项）

| # | 项 | 改法 |
|---|---|---|
| 9 | I2 隔离 | 临时目录下创建 `appdata\`，设置父进程 `JJ_DATA_DIR` 并显式传给所有 exe 调用；WebView2 profile 随数据目录；报告写实际路径；新增「用户数据目录未被改写」项（recent.json mtime/SHA256 前后一致）；README 的 ASCII 理由改为「隔离 + 路径含中文兼容」 |
| 10 | I3 采样保真 | 宿主 50 ms 采样；最大间隔（含启动到首样本、样本间）> 250 ms → FAIL 并写原因；报告写样本数/最大间隔 |
| 11 | I4 双开 | 改用 .NET Process 启动，断言第 2 个 `ExitCode == 0`；debug.log 交叉校验改为附加证据（不一致不影响判定） |
| 12 | I5 跳过测试 | 宿主 TRX `notExecuted`、vitest `skipped` 均 FAIL 并列出跳过项；默认 FAIL（无白名单）；`-SelfTest` 覆盖 skipped>0 |
| 13 | I6 整树指标 | 采样器先读宿主 `WorkingSet64` 并缓存，再做 CIM；宿主已退出/读不到时 `TreeApplicable=false`，报告显示「不适用」而不是 0；README/spec 改为本轮实测区间并说明采样窗口 |
| 14 | I7 5 万行 | 外层超时 180 s→60 s；干净超时重试 1 次并记录尝试次数/历史；超时把 debug.log 尾部写入实测列 |
| 15 | I8 清理安全 | 启动记录 (PID, StartTime, ImagePath)；杀进程树前逐个校验，不匹配则跳过并记录；报告写「清理与残留检查」；finally 兜底 |
| 16 | `-SelfTest` | 新分支：不构建/不跑产品，21 例固定样本覆盖 Test-ReadyPayload（合法/ready 字符串/缺 path/不符/elapsed 超限/toc 不足/超上限）、Test-HostTestSummary（总计 0/通过 0/skipped/failed/全绿）、Find-PdfReadyJson、Find-ReadyJson、路径比较、ASCII；正常验收第 0 步计入 16 项 |
| 17 | 严化阈值 | full-syntax `tocCount` 36–40（本轮 38）；huge ≥ 480（本轮 500）；内存项仅当 `$hugeReadyOk` 时判定，否则「不适用/FAIL」；验收开始删除旧报告；PDF 页数仍 >100 |
| 18 | quick-fail | `VerifyRender`/`VerifyPdf` 输入不存在时 `File.Exists` 预检 → exit 2（实测约 0.2 s 返回，不再等 15 s） |

## C. 打包

| # | 项 | 改法 |
|---|---|---|
| 19 | build 分发 | `build.ps1` 发布前清空目标目录（保留目录本身），发布后拷入 `install.ps1`、`uninstall.ps1`、`README.md`；默认/自包含同样处理；`install.ps1`/`uninstall.ps1` 默认优先同目录 exe、源码树回退 `..\out\`；`verify.ps1` 新增「分发包完整性」 |
| 20 | 样例脚本 BOM | `gen-huge-sample.ps1` 加 UTF-8 BOM；Windows PowerShell 5.1 `PSParser` 解析 OK（385 tokens），并实际运行生成 5 万行样本（与库内文件字节一致） |

## D. 验收证据与文档

| # | 项 | 改法 |
|---|---|---|
| 21 | 端到端首屏 | `verify.ps1` 用 `Invoke-CapturedFirstReady` 记录 `Process.Start`→stdout READY（同一进程数据复用给 full-syntax 校验）；< 1000 PASS、≤ 2500 WARN、> 2500 FAIL（本轮 1125–1202 ms WARN）；README/spec 同时给两套数字与口径解释 |
| 22 | 16ms 帧预算 | spec §2.3/§10、README、`verify-checklist.md` §16 记录 descope 与手测方法；明确「未自动验证」 |
| 23 | traceability | 新建 `docs/acceptance-traceability.md`：§2.3 六条拆成 7 行 + §9.3 七条 + 其它加固项；状态用「已自动验证 / 需人工 / 已 descope（含理由）」 |
| 24 | 手测记录/清单 | 新建 `docs/verify-record.md`（环境、自动结论、逐条人工项全部「未执行（需人工）」、复现命令）；`verify-checklist.md` 修正 Ctrl+Shift+C、删除「状态栏」、补自包含/版本/图标/首屏/帧预算/长 TOC、卸载「无需确认」 |
| 25 | spec 最终状态 | §8 改为实际构建/自包含 130–140 MB/单文件 apphost + WebView2 loader/FileDescription=鲸鲸阅读器/分发含 install+uninstall+README；§2.3/§10 补端到端与 16ms descope；内存数字与报告一致；§5.3 TOC descope；§5.9 UserChoice 实现确认；§4.4 补 openRecent/openTreeFile/notice/settings 并注明 openFile 仅相对路径 |
| 26 | README | Ctrl+Shift+C 文案、内存区间与实测一致、WebView2 profile 位置、`JJ_DATA_DIR`、分发内容/拷贝说明、PS 5.1/7 命令区分、协议/限制（openFile 相对、最近/树专用消息）、16ms descope、两套首屏数字 |
| 27 | ledger descope | `progress.md` 追加 TOC>300、16ms、快照测试、手测未执行四项及理由/后续建议；并记录本轮实测 |
| 28 | 小项 | `ProtocolTests` 注释改为实际 21 个可解析 type（23 个契约 type）；`SelfTestTests`/`AboutInfoTests` 改精确整行/正则/状态断言；`out/` 已 gitignore 确认 |

## 新验收项输出（最终 `out/verify-report.md`）

| 检查项 | 实测 | 结果 |
|---|---|---|
| 验收脚本自测 | 21 例 / 0 失败 | PASS |
| 构建 | exit 0 | PASS |
| 宿主单测 | 371 / 0 failed / 0 skipped | PASS |
| 前端单测 | 19 files / 447 tests / 0 skipped | PASS |
| ASCII 运行副本 | 1.6 MB；数据目录 `<temp>\appdata` | PASS |
| 分发包完整性 | exe + install + uninstall + README | PASS |
| 环境自检 | 产品名=鲸鲸阅读器 | PASS |
| full-syntax 首屏 | elapsedMs=110 ms、tocCount=38 | PASS |
| 端到端首屏 | 1174 ms（<1000 PASS / ≤2500 WARN） | WARN |
| 5 万行首屏 | elapsedMs=177 ms、tocCount=500 | PASS |
| 宿主私有内存峰值 | 166.1 MB（21 样本，最大间隔 66 ms） | PASS |
| PDF hello / huge | 18791 B / 1977619 B、1042 页 | PASS / PASS |
| 双开单实例 | 第 2 进程 ExitCode=0、进程数=1 | PASS |
| 前端产物 | 435762 B × 2、SHA256 一致 | PASS |
| 用户数据目录未被改写 | mtime/SHA256 前后一致 | PASS |

信息项：WebView2 组 292.4 MB、整树 451.7 MB（本轮 4 次运行区间：宿主 164.1–175.8 MB、WebView2 230.1–325.7 MB、整树 343.0–476.7 MB；采样窗口见报告）。

`pwsh -NoProfile -File scripts/verify.ps1 -SelfTest` → SELFTEST OK（21 例）；PS 5.1 同样 21/21。

## traceability / record 摘要

- `docs/acceptance-traceability.md`：§2.3-1a/1b/2/3/4a/4b/5/6 + §9.3-1..7 + 隔离/skip/采样/清理/超时/descope。自动项均有 verify 项或测试文件；需人工项均指向 checklist 章节；16ms、TOC>300、快照测试标注 descope 及理由。
- `docs/verify-record.md`：环境（Win10.0.19045 / .NET 10.0.12 / WebView2 155.0.4283.60 / PS 7.6.6 两次 + 5.1 一次）、16 项自动结论、16 类人工项全部「未执行（需人工）」、复现命令；自包含 135.8 MB 未在无 .NET 机器启动（需人工）。

## 未执行手测清单（本轮全部「未执行（需人工）」）

拖放（md/文件夹/非 md/多文件）、打开对话框（Ctrl+O/Ctrl+Shift+O/取消/按钮）、文件树（排序/惰性/重试/高亮/空目录/不可读）、主题三态与跟随系统、排版（字号/行距/行宽/字体/窄窗）、大纲（38/500/点击/联动/拖宽/折叠）、最近文件/位置记忆/F5/Alt←→/Ctrl+Shift+C、深色主题 PDF 视觉、关于面板/默认应用/复制诊断、.md 关联安装/卸载/UserChoice/损坏备份、长路径（>255）、5 万行滚动与位置恢复、大文件模式、双开窗口激活/最小化还原、首屏视觉与冷热启动 3 次、版本/图标、16ms 帧预算手测、350 项 TOC 交互观感。

## Descope 列表

1. **TOC >300 虚拟滚动**：成本/收益不成立；350 项全量渲染 < 500 ms（测试锁定）。
2. **16 ms 滚动帧预算**：无自动化测量手段；改手测，未验证。
3. **README 快照测试**：用结构断言替代（快照对清洗/高亮版本敏感、审阅价值低）。
4. **手测项**：本轮未执行，需人工按 checklist 完成后回填 record。

## Concerns / 残留

- 端到端首屏为 WARN 口径（1125–1202 ms），不代表 1.0 s 设计目标已达成；需在真实双击/热缓存场景手测确认。
- WebView2/整树信息项采样窗口短（500 ms 采样本轮 1–2 个），数值仅参考；宿主私有内存 4 次运行 164.1–175.8 MB，仍低于 200 MB 上限但接近，后续优化（150 MB 目标）仍属独立立项。
- 自包含产物未在「无 .NET 10 运行时」的机器上启动验证（构建与分发包完整性已自动验证）。
- 5 万行超时重试分支本轮未触发（首次即通过），仅经代码审查与 `-SelfTest` 间接覆盖；建议后续在故意挂起注入下演练一次。
- `.superpowers/` 整目录被 gitignore，本报告与 ledger 不会进入提交（与既往波次一致）。
- 完整的 Windows PowerShell 5.1 验收跑在最终「删除旧报告 guard / 清理记录」微调之前（纯报告逻辑）；最终脚本的 5.1 `-SelfTest` 仍 21/21，PS 7 最终全量 VERIFY OK。
