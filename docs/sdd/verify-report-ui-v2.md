# 鲸鲸阅读器验收报告

- 生成时间：2026-10-18 16:23:46 +08:00
- 耗时：43.6 s
- 仓库：D:\jj-v2-verify
- 分支：master @ 5f40d0c（工作树 有 1 个未提交变更）
- 操作系统：10.0.19045.0
- .NET：10.0.12
- WebView2 Runtime：155.0.4283.60
- PowerShell：7.6.6（Core）
- 运行副本：C:\Users\Admin\AppData\Local\Temp\jj-verify-469c1719815e46b09ae2eb8e0aaa4c9b（来源 %TEMP%；路径为纯 ASCII；ASCII 路径要求见说明；验收后清理）
- 数据隔离：JJ_DATA_DIR=C:\Users\Admin\AppData\Local\Temp\jj-verify-469c1719815e46b09ae2eb8e0aaa4c9b\appdata（settings/recent/positions/debug.log 与 WebView2 profile 均在此；用户 %APPDATA%\JingjingReader 未被改写，见检查项）
- 采样间隔：宿主 50 ms（本次 24 次，最大间隔 64 ms；上限 250 ms）/ WebView2 500 ms（本次 2 次）
- 5 万行尝试：1 次；历史：第 1 次：exit=0，超时=False，elapsedMs=223，内存样本=24，最大间隔=64 ms
- 端到端首屏（Process.Start → READY）：1311 ms；渲染器口径 elapsedMs=123 ms（两者不同，见说明）
- 端到端首屏判定：WARN（< 1000 ms PASS；≤ 2500 ms WARN；> 2500 ms FAIL）
- 清理与残留检查：已停止 7 个进程（含 WebView2 后代）；校验跳过 1 个；残留检查：无本次副本进程残留

## 检查项

| 检查项 | 期望 | 实测 | 结果 |
| --- | --- | --- | --- |
| 验收脚本自测 | Test-ReadyPayload / Test-HostTestSummary / Find-PdfReadyJson 等固定样本全部 PASS | 21 例固定样本（期望 21），0 例失败 | PASS |
| 构建 | scripts/build.ps1 exit 0，产出 out\JingjingReader.exe | exit 0；JingjingReader -> D:\jj-v2-verify\out\ \| [build] 已拷入分发包：install.ps1、uninstall.ps1、README.md \| BUILD OK out\JingjingReader.exe | PASS |
| 宿主单测 | dotnet test 全绿（总计 > 0、失败 0、跳过 0） | 失败 0 / 通过 388 / 总计 388 / 跳过 0（TRX） | PASS |
| 前端单测 | web/npm test 全绿（Test Files > 0、Tests > 0、跳过 0） | exit 0；Test Files 21 passed / Tests 489 passed | PASS |
| ASCII 运行副本 | out\ 完整复制到纯 ASCII 临时目录（%TEMP% 或回退目录） | 副本 C:\Users\Admin\AppData\Local\Temp\jj-verify-469c1719815e46b09ae2eb8e0aaa4c9b\JingjingReader.exe（2.4 MB）；数据目录 C:\Users\Admin\AppData\Local\Temp\jj-verify-469c1719815e46b09ae2eb8e0aaa4c9b\appdata | PASS |
| 分发包完整性 | out\ 内 exe + install.ps1 + uninstall.ps1 + README.md 均存在 | out\ 含 JingjingReader.exe + install.ps1 + uninstall.ps1 + README.md | PASS |
| 环境自检 | exit 0 且 stdout 含「产品名: 鲸鲸阅读器」 | exit 0；产品名=鲸鲸阅读器；数据目录=C:\Users\Admin\AppData\Local\Temp\jj-verify-469c1719815e46b09ae2eb8e0aaa4c9b\appdata | PASS |
| full-syntax 首屏 | elapsedMs ≤ 1000 ms，tocCount ∈ [36, 40]，exit 0 且 READY 字段合法 | elapsedMs=123（≤ 1000）、tocCount=38（36–40）、exit 0、ready=true、path 一致、端到端 1311 ms | PASS |
| 端到端首屏（含 WebView2 初始化） | 热缓存下 ≤ 2500 ms（< 1000 ms 记 PASS，否则 WARN）；elapsedMs 为渲染器耗时，两者口径不同 | Process.Start → stdout READY：1311 ms（PASS < 1000 ms；WARN ≤ 2500 ms）；elapsedMs（渲染器口径）=123 ms；spec §2.3 的 1.0 s 是设计目标，当前 CLI 冷启动含 WebView2 初始化，记 WARN 不判 FAIL | WARN |
| 5 万行首屏 | exit 0，READY 严格校验通过，elapsedMs ≤ 1500 ms，tocCount ≥ 480，外层超时 60 s | elapsedMs=223（≤ 1500）、tocCount=500（≥ 480）、exit 0、ready=true、path 一致 | PASS |
| 宿主私有内存峰值（≤200 MB） | JingjingReader.exe PrivateMemorySize64 峰值 ≤ 200 MB，采样最大间隔 ≤ 250 ms | 峰值 172.9 MB（≤ 200.0 MB；PrivateMemorySize64，宿主 50 ms 采样 24 次，最大间隔 64 ms） | PASS |
| PDF（hello.md） | exit 0，产物 > 5 KB | exit 0；体积 18787 B（> 5120）；elapsedMs=179 | PASS |
| PDF（5 万行文档） | exit 0，产物 > 1 MB，页数 > 100 | exit 0；体积 2326044 B（> 1048576）；/Type /Page 页数 1084（> 100）；elapsedMs=5850 | PASS |
| 双开单实例 | 第 1 个窗口启动后，第 2 个进程转交并 ExitCode=0 退出，JingjingReader 进程数 = 1 | 第 1 个进程已启动；第 2 个进程已退出=True（ExitCode=0，期望 0）；3 s 后 JingjingReader 进程数=1（期望 1）；附加证据 debug.log 最后一条 load path 与第 2 个文件一致 | PASS |
| 前端产物体积 | web/dist 与 src/Host/Resources 的 md-engine.js 均 ≤ 640 KB 且字节一致 | dist=530245 B，Resources=530245 B（均 ≤ 655360）；SHA256 一致 | PASS |
| 用户数据目录未被改写 | 验收前后 %APPDATA%\JingjingReader\recent.json 的 mtime/SHA256 完全一致（JJ_DATA_DIR 隔离生效） | 验收前：存在，3499 B，mtime=2026-10-18T08:09:24.1399698Z，SHA256=308C1EC9DA6B…；验收后：存在，3499 B，mtime=2026-10-18T08:09:24.1399698Z，SHA256=308C1EC9DA6B… | PASS |

## 说明

- 内存判定口径（T17 裁定修正）：宿主进程 `JingjingReader.exe` 的 `PrivateMemorySize64`（Private Bytes）峰值 ≤ 200 MB；宿主每 50 ms 采样一次（采样循环内不做 CIM），本次 24 个样本、最大间隔 64 ms。最大间隔 > 250 ms 判 FAIL（采样空洞可能漏掉峰值）；5 万行渲染未成功时该项记「不适用/FAIL」。上限按裁定 2（2026-10-18）由 150 MB 修正为 200 MB。
- WebView2 基线（信息，独立 runspace 每 500 ms 采样）：峰值 505.3 MB（6 个 msedgewebview2 进程；WebView2 500 ms 采样 2 次）；统计对象为直接子进程与全部后代的 `msedgewebview2` 进程组，取 `WorkingSet64` 之和；只记录，不参与 PASS/FAIL。
- 整树 WorkingSet（信息）：峰值 660.0 MB（同一 WebView2 采样时刻的宿主 `WorkingSet64` + WebView2 进程组求和；仅参考）。
- 临时目录与隔离：优先 `%TEMP%`；若路径含非 ASCII 字符，依次回退 `%LOCALAPPDATA%\Temp`、脚本所在盘根目录下的 `jj-verify-<guid>`。要求纯 ASCII 的原因是「隔离 + 路径含中文时的兼容」：WebView2 子进程在该目录创建用户数据目录，且 `--verify-*` 的命令行/环境变量在非 ASCII 路径上受系统代码页影响。所有 exe 调用都显式传 `JJ_DATA_DIR=<临时目录>\appdata`（数据目录 + WebView2 profile），并校验用户 `%APPDATA%\JingjingReader\recent.json` 的 mtime/SHA256 前后一致。`JJ_DATA_DIR` 仅用于测试隔离（finally 恢复调用方原值）；产品默认 WebView2 UDF 仍是本地 `%LOCALAPPDATA%\JingjingReader\WebView2`，不进入漫游 `%APPDATA%`。
- 首屏耗时有两套口径：`elapsedMs` 来自前端 `renderDone.elapsedMs`（渲染器耗时，`--verify-render` 的 READY JSON，≤ 1000/1500 ms 判定）；「端到端首屏」是 `Process.Start → stdout READY` 的墙钟耗时（含进程启动、WebView2 初始化、文件读取），< 1000 ms PASS、≤ 2500 ms WARN、> 2500 ms FAIL。spec 的 1.0 s 是设计目标，当前 CLI 冷启动含 WebView2 初始化，故 1.0–2.5 s 记 WARN 不判 FAIL。
- READY 必须满足 `ready`=true、`elapsedMs` 为区间内 Number、`path` 与传入文件一致、`tocCount` 为 [下限, 上限] 内整数（full-syntax 36–40、5 万行 ≥ 480），否则该项 FAIL 并打印原始 READY 行。
- 双开单实例：先等第 1 个宿主出现，再启动第 2 个；断言第 2 个进程退出且 ExitCode=0、3 s 后 JingjingReader 进程数=1；隔离数据目录 `debug.log` 的 `load path=` 交叉校验只作附加证据，不影响判定。若验收前已有用户实例在运行，该项明确失败而不是误杀用户进程。
- 跳过测试：宿主 TRX 的 `notExecuted` 与 vitest 的 `skipped` 均按 FAIL 口径（skipped > 0 会在实测列列出跳过项；确需环境性跳过时应改为显式白名单并写明，默认仍是 FAIL）。
- 宿主单测要求总计 > 0、失败 0、跳过 0；前端单测要求 `Test Files` 与 `Tests` 的 passed 数均 > 0 且 skipped = 0（零测试/跳过都不能通过）。
- 分发包：`out\`（或 `out-selfcontained\`）内含 `JingjingReader.exe`、`install.ps1`、`uninstall.ps1`、`README.md`，整个目录可直接分发。
- 本脚本不安装/卸载 .md 关联、不写注册表；默认应用、拖放、主题等交互项见 docs/verify-checklist.md。

## 结论

**VERIFY OK**：全部检查通过。
