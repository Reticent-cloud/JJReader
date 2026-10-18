# 修复波 D 报告（最终复评残余）

- 日期：2026-10-18
- 分支：`feat/jingjing-reader`
- 基线：`c01e113`（复评前的 HEAD）
- 本轮提交：`013cbe1`（单条中文 commit，未改写历史；`6a124a5` 为同一内容、仅文档数字同步前的 amend 前身）
- 结论：**完成**。host **382** tests / web **21 files / 474 tests** 全绿；`scripts/verify.ps1` **VERIFY OK**（16 项：15 PASS + 1 WARN + 0 FAIL）；`-SelfTest` **21/21**（并已实际验证「少一例」时 exit 1）；`out/verify-report.md` 保留为最终权威证据。

## 1. Important 回归：WebView2 UDF 默认路径回到本地 `%LOCALAPPDATA%`

**改法**（`src/Host/AppPaths.cs:63-82`）
- 新增 `ResolveWebViewDataDir(override, localAppDataRoot)`：
  - 未设置 / 空 / 非法 `JJ_DATA_DIR` → `%LOCALAPPDATA%\JingjingReader\WebView2`；
  - 有效 `JJ_DATA_DIR` → `<JJ_DATA_DIR>\WebView2`。
- `DataDir`（settings/recent/positions/debug.log）保持 `%APPDATA%\JingjingReader` + 覆盖值，行为不变；覆盖值解析抽成 `TryResolveOverride`，非法值仍静默回退。
- 更新 AppPaths/MainWindow 注释，明确 UDF 与数据目录分离、`JJ_DATA_DIR` **仅用于测试隔离**；README（数据目录/卸载清理）、spec §7 同步。

**测试证据**（`tests/host/AppPathsTests.cs`）
- 新增 `Default_webview_dir_is_localappdata_jingjingreader_webview2`：清空环境变量 → UDF 为 LocalAppData 路径、`DataDir` 仍为 Roaming AppData。
- 新增 `Resolve_webview_dir_uses_localappdata_or_valid_override`：null/空白/非法覆盖值 → 本地默认；有效覆盖 → `<override>\WebView2`。
- 既有 `Environment_variable_controls_data_and_webview_dirs` 继续覆盖「设置环境变量 → 其下 WebView2」。
- RED 证据：改实现前上述新测试编译失败（`ResolveWebViewDataDir` 不存在）；补实现后通过。

## 2. M10 转义破坏 hljs XML 正则

**改法**（`src/Host/MainWindow.xaml.cs:1507-1524`）
- `EscapeScriptContent` 只保留两种转义：`</script` → `<\/script`、`<!--` → `<\!--`；**不再改写 `<script`**。
- `BuildPageHtml` 改为 `internal` 仅用于测试（产品调用链不变）。
- 注释说明：`<script` 在脚本数据态不会闭合当前脚本；改写会破坏 `/<script(?=\s|>)/`（`\s` 被换成空白类），导致 `<script>` 代码块高亮降级。

**测试证据**（`tests/host/PageHtmlTests.cs`，6 个用例）
- 断言 `</script` 被转义、`<!--` 被转义、`<script>` 字面保留；大小写不敏感 + 幂等。
- 正则语义断言：输入含 `/<script(?=\s|>)/` 与 `'<script>'` 时，输出逐字保留 `<script(?=\s|>)` 与 `<script>`（`Assert.Equal(source, escaped)`）。
- bundle 级断言：嵌入的 `md-engine.js` 转义前后 `<script` 出现次数一致（当前 1 处，hljs XML 模式）。
- 页面级断言：`BuildPageHtml()` 的 `<script` 次数 = index.html + bundle 原始次数；`</script`/`<!--` 只来自 index.html，bundle 中的序列全部被转义；页面仍含 `<script(?=\s|>)>` 原文与 `<script id="md-engine">`。
- RED 证据：临时恢复旧的三段转义后，PageHtml 用例 5 个失败（diff 显示 `<\\script>`）；恢复修复后全绿。

## 3. 文档/证据数字漂移

以**最终一次** `verify.ps1` 输出为准（2026-10-18 05:01，PowerShell 7.6.6）：

| 项 | 最终实测 |
|---|---|
| 端到端首屏 | **1150 ms**（WARN） |
| full-syntax `elapsedMs` | **121 ms**，tocCount 38 |
| 5 万行 `elapsedMs` | **190 ms**，tocCount 500 |
| 宿主私有内存峰值 | **162.8 MB**（21 样本，最大间隔 65 ms） |
| WebView2 进程组（信息项） | 321.8 MB（5 个进程，2 样本） |
| 整树 WorkingSet（信息项） | 475.8 MB |
| 宿主单测 / 前端单测 | **382** passed / **21 files, 474 tests** |
| 前端产物 | **472869 B** × 2，SHA256 一致 |
| PDF hello / huge | 18787 B / 2314459 B、1084 页 |

- README：注意 1/2（147/149）与「已知限制」（209/210）改为上述最终数字；数据目录/卸载清理说明改为「UDF 在 `%LOCALAPPDATA%\JingjingReader\WebView2`」。
- spec §2.3 第 1/2/4 条、§10 表与说明改为最终数字；§2.2 A5 改为「Classes/打开方式可恢复；UserChoice 需用户重选」（与 §5.9 一致）；§4.4 `dirListing` 补 `root`；§4.5 导航措辞改为「取消 WebView 内导航（初始装载与 #fragment 除外），http(s) 交系统浏览器」；§9.1 5 篇快照标注 descope（结构断言替代）；§9.3 第 1/10 条补 SelfTest 总数与重试清理。
- `docs/acceptance-traceability.md`：全部「本轮」数字改为最终值；**修正 2.3-2**：SelfTest 只覆盖 READY/测试统计/PDF-ready 等纯函数，内存判据标注「e2e 项，未在 SelfTest 内」；单测数改为 382/474/21 files。
- `docs/verify-record.md`：保留波 C 历史口径，顶部加注「波 D 最终数字以 `out/verify-report.md` 为准」。
- `out/verify-report.md`：由最终 verify 重新生成（VERIFY OK，16 项），并补 `commit: 013cbe1…` 行；脚本已写分支/commit，工作树 clean。

## 4. verify.ps1 残余风险

| 项 | 改法 | 证据 |
|---|---|---|
| 超时读取无界等待 | 新增 `Receive-TaskText`（`Wait(5s)` 后读 Result，超时/异常返回 `''`）；替换 `Invoke-Captured:389-390`、`Invoke-CapturedFirstReady:505`、`Invoke-HugeRenderProbe:637-638` 的 `.Result` | 独立验证：未完成任务 500 ms 超时实际 0.52 s 返回空；已完成任务立即返回 |
| 重试残留 | 新增 `Stop-WebViewDescendants`（按父 PID BFS 杀 `msedgewebview2.exe` 后代）与 `Clear-WebViewProfile`（清理 `<JJ_DATA_DIR>\WebView2`，重试 10×200 ms） | 超时分支在 retry 前调用并把清理数写入报告历史（本次 e2e 未触发超时，首次即通过） |
| `JJ_DATA_DIR` 泄漏 | 保存原值/存在性，`finally` 中「存在还原、不存在删除」 | 代码路径；`finally` 在 `exit` 前执行 |
| SelfTest 只看零失败 | `$ExpectedSelfTestCases = 21`；`-SelfTest` 与正常验收第 0 步均断言「总数 21 且 0 失败」，否则 FAIL | 复制脚本删掉 1 例后运行：exit 1，输出「SELFTEST FAILED（0 例失败；期望 21 例，实际 20 例）」 |
| 门槛 | 全部现有门槛（1000/1500/2500 ms、200 MB、采样间隔 250 ms、PDF/单实例/产物大小等）保持不变；新增的 5 s 读取超时只在超时路径生效 | 最终 verify 16 项：15 PASS + 1 WARN，0 FAIL |

## 5. 宿主测试残余

- `tests/host/NoteResolverTests.cs:143-148`：junction 创建失败由静默 `return` 改为 `Assert.Fail("环境不支持创建 junction/symlink，无法验证 reparse 限制")`，与 DirectoryListerTests 同策略。
- `NoteResolver.ResolveExisting`（`src/Host/NoteResolver.cs:204-211`）：把逐段 reparse 检查从「只查目录」改为**目录与最终文件都查**；BFS 直连文件路径（`ResolveCandidateInSubdirectory`）也补文件级检查。
- 新测试 `FindNote_rejects_final_file_that_is_a_reparse_point`：
  - 优先用 `mklink`/`File.CreateSymbolicLink` 建 `.md` 文件链接；本机无 `SeCreateSymbolicLinkPrivilege` 时回退到系统已有的文件重解析点（`%LOCALAPPDATA%\Microsoft\WindowsApps` 的 AppExecLink）；
  - 断言 `FindNote`/`FindAttachment` 均返回 null；两种夹具都不可用则 `Assert.Fail`。
  - RED 证据：旧实现返回 `NoteHit{...WindowsApps\GameBarElevatedFT_Alias.exe}`，测试失败；修复后通过。

## 最终验收（`out/verify-report.md`）

| 检查项 | 实测 | 结果 |
|---|---|---|
| 验收脚本自测 | 21 例（期望 21），0 失败 | PASS |
| 构建 | exit 0，BUILD OK out\JingjingReader.exe | PASS |
| 宿主单测 | 382 / 0 failed / 0 skipped | PASS |
| 前端单测 | 21 files / 474 tests / 0 skipped | PASS |
| ASCII 运行副本 | 1.7 MB，`<temp>\appdata` | PASS |
| 分发包完整性 | exe + install + uninstall + README | PASS |
| 环境自检 | 产品名=鲸鲸阅读器 | PASS |
| full-syntax 首屏 | elapsedMs=121 ms、tocCount=38 | PASS |
| 端到端首屏 | 1150 ms | WARN |
| 5 万行首屏 | elapsedMs=190 ms、tocCount=500、1 次通过 | PASS |
| 宿主私有内存峰值 | 162.8 MB（21 样本，最大间隔 65 ms） | PASS |
| PDF hello / huge | 18787 B / 2314459 B、1084 页 | PASS / PASS |
| 双开单实例 | 第 2 进程 ExitCode=0、进程数=1 | PASS |
| 前端产物 | 472869 B × 2、SHA256 一致 | PASS |
| 用户数据目录未被改写 | recent.json mtime/SHA256 前后一致 | PASS |

> 信息项：WebView2 组 321.8 MB、整树 475.8 MB（500 ms 采样仅 2 个样本，仅参考）。

## 复现命令（本轮已执行）

```powershell
dotnet test tests/host/JingjingReader.Tests.csproj   # 382 passed / 0 failed / 0 skipped
cd web; npm test                                      # 21 files / 474 tests passed
pwsh -NoProfile -File scripts/build.ps1               # BUILD OK
pwsh -NoProfile -File scripts/verify.ps1              # VERIFY OK（16 项：15 PASS + 1 WARN）
pwsh -NoProfile -File scripts/verify.ps1 -SelfTest    # SELFTEST OK（21 例）
```

## Concerns

- 最终 verify 运行于 `6a124a5`（与最终 `013cbe1` 的代码/测试完全相同，差异仅为文档数字同步）；`out/verify-report.md` 已补 `commit: 013cbe1…（工作树 clean）` 并注明该事实，未重新跑第三次以免数字再次漂移。
- 5 万行超时重试分支本轮未触发（首次即通过）；`Stop-WebViewDescendants`/`Clear-WebViewProfile` 为代码审查 + 独立超时读取验证，未做真实挂起注入。
- WebView2/整树信息项只有 2 个 500 ms 样本，数值仅参考，不参与判定。
- 宿主测试从 376 增至 382（新增 6 个），因此文档/报告统一写 382；web 仍 474。
- 端到端首屏仍为 WARN（1150 ms，> 1.0 s 设计目标）；人工手测项（拖放/对话框/主题/字体/文件树/关联/长路径/PDF 视觉等）本轮仍未执行，需按 `docs/verify-checklist.md` 人工完成。
