# fix-wave-A 报告：最终评审 C1/C2 + 相邻 Minor（M3–M11）

- 分支：`feat/jingjing-reader`
- 基线：`5749721`（VERIFY OK 12/12；宿主 216、前端 382 为波次前记录）
- 范围：仅 C1、C2、M3–M11；未触碰 I1/I2/I3/I4、错误条与测试加固波。
- 提交：`f8207f4`（单个中文 `fix:` commit，未改写既有历史）。

## C1（Critical）内容可达的 openFile 任意路径

### 改法

1. **协议拆分**（`src/Host/Protocol.cs`、`src/Host/MainWindow.xaml.cs`）
   - `openFile{relPath}` 只接受相对路径：先过 `OpenPathPolicy.IsContentTargetAllowed`，
     绝对路径、UNC、盘符绝对/盘符相对、`\` / `/` 根相对、`\\?\`/`\\.\`、含 `:`（ADS）与 `..` 段一律拒绝，
     toast「不支持打开该路径」，不再有 `Path.IsPathFullyQualified → NormalizePath` 直开分支。
     解析仍走 `OpenTargetResolver.Resolve(docDir, relPath)`（内部 ResolveInside containment）。
   - 新增 `openRecent{path}`：`FileHost.NormalizePath(path)` 必须在 `Store.LoadRecent()` 中
     （归一化后大小写不敏感比较），否则拒绝并 toast。
   - 新增 `openTreeFile{path}`：仅当 `FileHost.ResolveInside(_browseRoot, path) != null` 且
     `FileHost.IsMarkdown(path)`（md/markdown/mdown/txt）才打开；未选浏览根/越界/类型不符一律拒绝。
   - `Assoc` 未改动。
2. **纯函数校验**（新增 `src/Host/OpenPathPolicy.cs`）
   - `IsContentTargetAllowed(string? relPath)`
   - `IsRecentPath(string? normalizedPath, IEnumerable<RecentEntry>? recent)`
   - `IsInsideBrowseRoot(string? browseRoot, string? absPath)`
3. **reparse-point 加固**（`src/Host/NoteResolver.cs`、`src/Host/OpenTargetResolver.cs`）
   - `ResolveExisting` 的显式相对目标逐段检查目录重解析点（junction/symlink 返回 null）；
     与 BFS 的 reparse 口径一致，隐藏目录仍允许显式指定（保持既有语义）。
   - `OpenTargetResolver` 精确命中在 `RecoverExisting` 失败时不再回退到未校验的 `direct`
     （否则 junction 可绕过字符串前缀 containment）。
4. **前端调用点**
   - `web/src/shell/main.js`：最近面板、工具条最近菜单、Alt+←/→ 改发 `openRecent{path}`；
   - `web/src/shell/browse.js`：文件树点击改发 `openTreeFile{path}`；
   - wikilink/附件（`#content` 委托）继续发 `openFile{relPath}`（相对）。
5. **测试**
   - `tests/host/OpenPathPolicyTests.cs`：绝对路径、UNC、`\\?\`/`\\.\`、盘符相对、根相对、`..`、
     `javascript` 无关项、合法相对（含 `./`、中文/空格）；最近列表命中/未命中/坏条目跳过/相对入参拒绝；
     浏览根内/外/同前缀兄弟目录/根本身/`..`。
   - `tests/host/NoteResolverTests.cs`：新增 junction 用例（`cmd /c mklink /J`，环境不允许时跳过），
     验证显式 `link\secret`、普通 `secret` 与 `OpenTargetResolver` 均不穿越。
   - `tests/host/ProtocolTests.cs`：`openRecent` / `openTreeFile` 进入 KnownTypes 并解析 `payload.path`。
   - 前端：`tests/web/shell-ux.test.js`（最近面板/菜单/Alt+←→ 断言 `openRecent`）、
     `tests/web/tree.test.js`（树点击断言 `openTreeFile`）。

### 需手测

- 真实 UI：恶意 `.md` 中 `[[C:\Windows\win.ini]]`、`[[\\attacker\share\x]]`、`[[..\secret.md]]`
  点击 → toast「不支持打开该路径」，debug.log 有拒绝记录，不读取文件、不发起 UNC 认证。
- 正常 wikilink/附件（相对路径）、最近面板/菜单/Alt+←→、文件树打开均无回归。

## C2（Critical）NavigationStarting 守卫与消息来源校验

### 改法

1. **NavigationStarting**（`MainWindow`）：注册 `core.NavigationStarting`；只放行
   - 初始 `NavigateToString` 装载（`_initialNavigationPending` 一次标记）；
   - 同文档 `#fragment`（目标去 fragment 后与 `CoreWebView2.Source` 去 fragment 相等）。
   其余 `e.Cancel = true` 并记录「已拦截 WebView 内导航」；http(s) 目标转系统浏览器
   （`Process.Start(UseShellExecute)`，失败日志）。逻辑抽到 `WebViewSecurityPolicy.IsAllowedNavigation`。
2. **消息来源校验**：`OnWebMessageReceived` 先校验 `e.Source`，只接受应用文档源
   `WebViewSecurityPolicy.IsTrustedMessageSource`（`about:blank`，允许 `#fragment`）；
   不匹配记日志后丢弃。**实测 e.Source = `about:blank`（见下）**，未接受任意来源。
3. `CoreWebView2Settings.AreDefaultContextMenusEnabled = false`。
4. `web/src/enhance.js`：对每个 `a[href]` 用 `new URL(href, document.baseURI)` 解析；
   显式 http:/https:（大小写不敏感，`HTTPS://` 命中）与协议相对 `//host/...` 补
   `target="_blank" rel="noopener noreferrer"`；站内锚点/相对链接/`javascript:`/`mailto:` 不改写。
   `//host` 在 `about:blank` 下按 WHATWG 解析会抛错（非特殊 scheme），因此按原串识别协议相对地址，
   解析失败不影响改写（避免生产环境漏改写、而 jsdom 的 http base 测试掩盖问题）。
   复制按钮与图片占位逻辑保持不变。
5. `README.md` 安全描述改为「WebView 内导航被拦截（外部链接在新窗口/系统浏览器打开）……」。
6. **测试**
   - `tests/host/WebViewSecurityPolicyTests.cs`：可信来源（about:blank/about:blank#x/大小写/空白）、
     远程/`about:blank.evil`/`file:`/`data:`/空来源拒绝；初始导航放行、同文档 fragment 放行、
     整页 about:blank/外站/空值拒绝；`TryGetHttpUri` 仅 http(s)。
   - `tests/web/engine-gfm.test.js`：外链 `rel` 更新为 `noopener noreferrer`；新增
     `HTTPS://`、`//example.com` 改写与 `javascript:`/`mailto:`/`#anchor` 不改写用例；
     另有 `document.baseURI='about:blank'` 下协议相对外链仍改写的用例（覆盖生产 base）。
   - 前端全量 384 通过。

### 实测证据（真实 e.Source 与导航取消）

临时日志（已从代码删除）加在 `OnWebMessageReceived` 与 `--verify-render` 收尾处，用 ASCII 临时目录副本运行
（仓库路径含中文时 WebView2 初始化会失败，脚本本身也要求 ASCII 运行目录）：

- `%APPDATA%\JingjingReader\debug.log`：
  - `2026-10-18T03:11:54.974+08:00 TEMP webMessage source='about:blank' webviewSource='about:blank'`
    → 真实 `e.Source` 为 **`about:blank`**，与 `CoreWebView2.Source` 一致。
  - 注入 `<a href="HTTPS://example.com/nav-guard">` 的临时样例（`samples` 仓库文件未改）渲染后：
    `TEMP link attrs="{\"href\":\"HTTPS://example.com/nav-guard\",\"target\":\"_blank\",\"rel\":\"noopener noreferrer\",\"base\":\"about:blank\"}"`
    → 大小写混合外链被 enhance 改写，`base` 为 `about:blank`。
  - `2026-10-18T03:17:19.587+08:00 已拦截 WebView 内导航：https://example.invalid/nav-guard`
  - `2026-10-18T03:17:19.814+08:00 外链交给系统浏览器：https://example.invalid/nav-guard`
  - `2026-10-18T03:17:20.617+08:00 TEMP location-after-guard="about:blank"`
    → 导航被取消，页面仍是应用文档（若未拦截会变成导航目标）。
  - 另：`file:///C:/Windows/win.ini` 与 `data:text/html,...` 的 `location` 赋值未触发
    NavigationStarting（Chromium 在进入导航前即拒绝），因此用 `https://` 目标完成取消验证。
- 临时改动（MainWindow 临时 source 日志、VerifyRender 临时脚本）已全部移除；`grep -rn TEMP src/Host` 为空。

### 需手测

- 真实 UI 点击 `.md` 内 `HTTPS://` / `//host` 外链：新窗口请求被取消并交给系统浏览器；WebView 不导航。
- 正文内 `#标题`、脚注回跳等 fragment 跳转仍正常（NavigationStarting 放行同文档 fragment）。
- 右键菜单不再出现 Reload/Back 等默认项。

## Minor

### M3 savePosition 陈旧 key

- `SavePosition` 先用 `MainWindow.IsCurrentDocumentKey` 比对 `message.Key` 与 `_currentDocument.Key`；
  不匹配丢弃并记录 key/current 日志，避免旧 key 写到新文档路径。
- 测试：`tests/host/SavePositionGuardTests.cs`（相等/大小写/陈旧/空值）。

### M4 Assoc.Uninstall 恢复 OpenWithProgids 原值

- `AssocBackup` 增加 `openWithProgidValue`（旧备份缺字段反序列化为 null，向后兼容）；
  `Install` 记录安装前值；`Uninstall` 在 `HadOpenWithProgid=true` 时写回原值
  （旧备份按空串恢复「值存在」），否则删除本程序新增值。
- 测试：`Install_backs_up_and_uninstall_restores_existing_open_with_progid_value`、
  空串恢复、旧备份（无字段）恢复；`AssocTests` 全绿。

### M5 Assoc.GetState 读 UserChoice

- `GetState` 优先 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice\ProgId`，
  缺失/空白回退 `Software\Classes\.md` 默认值；新增 `Assoc.UserChoiceKey()`。
- 测试：UserChoice 优先（指向别人 → 非默认）、指向本程序 → 默认、缺失/空值回退。

### M6 openDefaultApps

- 在 `Dispatch` 实现：`Process.Start(new ProcessStartInfo("ms-settings:defaultapps"){UseShellExecute=true})`，
  失败记日志并 toast「无法打开默认应用设置」；不再落入 default 忽略分支。
- 前端当前没有调用点（`grep openDefaultApps web/src` 为空），属于协议预留；需手测（发送消息后系统设置打开）。

### M7 VerifyPdf 输入输出同路径

- `RunCoreAsync` 在删除旧输出**之前**用 `VerifyPdf.IsSamePath` 判定；相同则输出
  `PDF-FAILED 参数错误：输入与输出是同一个文件` 并 `Shutdown(2)`，不删除输入。
- 测试：`IsSamePath`（大小写/`.`/不同文件/空）且断言输入仍存在、内容不变；
  端到端实测：`--verify-pdf <tmp>/jj-same.md <同一路径>` → exit 2，文件存在且 SHA256 不变。

### M8 UI 导出失败清理与 toast

- 失败：`DeletePartialPdf(path, existsBefore, writeTimeBefore)` 只删除本次写出的半成品；
  导出前已存在且最后写入时间未变则保留用户原文件（避免「进入打印模式就失败」误删旧 PDF）。
- 成功：toast 显示**完整路径**（`已导出 PDF：<full path>`）。
- `PdfExport` 的 finally 退出脚本调用最多等 3 s（`ExitScriptTimeoutMilliseconds`），超时仅日志，
  导出状态照常复位。
- 测试：`ExportCleanupTests`（新建半成品删除、原文件未改写保留、被改写删除、文件不存在 no-op）；
  `PdfExportTests.Exit_script_timeout_returns_without_hanging_and_resets_state` 与常量断言。

### M9 IpcServer 读超时与发送重试

- 读：`ReadPayload(stream, timeoutMs=2000)` 用 `ReadAsync + CancellationTokenSource`；
  超时记日志、放弃该连接，监听循环继续。生产 `ReadTimeoutMilliseconds=2000`；`Start` 增加 internal 超时重载供测试。
- 发送：`SendAsync` 经 `SendWithRetryAsync` 最多 3 次尝试（2 次重试，退避 50/100 ms）。
- 测试：`ReadPayload` 正常行/超长行/静默流超时（AnonymousPipe）、真实管道「哑连接后继续服务」、
  `SendWithRetryAsync` 第 3 次成功与始终失败（各 3 次尝试）。

### M10 BuildPageHtml 三类转义

- 抽出 `MainWindow.EscapeScriptContent`：`</script`→`<\/script`、`<script`→`<\script`、
  `<!--`→`<\!--`（大小写不敏感、幂等，已转义不二次转义）。
- 测试：`tests/host/PageHtmlTests.cs`（三类片段、大小写、幂等、普通代码不变）。

### M11 50 MB 上限

- `FileHost.MaxDocumentBytes = 50 MB`、`IsTooLarge`（严格大于）；`PushDocument` 读文件前检查，
  超限 toast「文件过大，暂不支持打开（>50MB）」并拒绝。
- 测试：`FileHostTests.IsTooLarge_allows_exactly_50_mb_and_rejects_more`。
- UI toast 与真实 50 MB 文件走查列入手测。

## 全量验证（最终）

- `dotnet test tests/host/JingjingReader.Tests.csproj`：**313 通过 / 0 失败**。
- `cd web && npm test`：**15 文件 / 384 通过**。
- `pwsh scripts/build.ps1`：**BUILD OK out\JingjingReader.exe**。
- `pwsh scripts/verify.ps1`：**VERIFY OK**（12 项 PASS：构建、宿主 313、前端 384、ASCII 副本、自检、
  full-syntax 112 ms/38、5 万行 163 ms/500 与宿主私有内存峰值 164.1 MB、PDF hello 18791 B、
  PDF huge 1977619 B/1042 页、双开单实例、产物一致性）。
- 说明：仓库路径含中文，运行实测均在 ASCII 临时副本中进行（verify.ps1 自身行为）。

## 需手测清单（汇总）

1. 恶意 wikilink（绝对/UNC/`..`）点击拒绝与 toast；正常 wikilink/附件无回归。
2. 最近面板/菜单/Alt+←→ 正常打开；篡改 path 的 `openRecent` 被拒绝。
3. 文件树正常打开 md/txt；点击非文本文件/越界路径被拒绝。
4. 真实 UI 点击 `HTTPS://`、`//host` 外链：系统浏览器打开，WebView 不导航；`#标题` 跳转正常。
5. 右键默认菜单已关闭。
6. 51 MB 文件打开提示「文件过大，暂不支持打开（>50MB）」。
7. PDF 导出失败后的半成品清理、已有文件保留；成功 toast 显示完整路径；退出打印模式卡住 3 s 后日志。
8. `openDefaultApps`（当前无前端入口）消息触发系统「默认应用」设置。
9. 真实注册表 install/uninstall（UserChoice 环境）与卸载后 OpenWithProgids 原值恢复（FakeRegistry 已覆盖逻辑）。
