# fix-wave B 报告：最终评审功能缺口（宿主 I1–I4 + §5.11 错误态 + 关联 UserChoice + 前端结构/可达性）

- 分支：`feat/jingjing-reader`
- 基线：`f8207f4`（安全波 A 完成，VERIFY OK 12/12；宿主 313 / 前端 384）
- 范围：仅任务书列出的 19 项；未改 `scripts/verify.ps1`、未改计划、未回退安全波 A 行为。
- 提交：单个中文 `fix:` commit（不改写历史）。
- 结果：宿主 **370** tests、前端 **416** tests、`scripts/build.ps1` 成功、`scripts/verify.ps1` → **VERIFY OK 12/12**。

## 宿主

### 1. I1 窗口几何持久化（spec §5.1）

**改法**
- 新增 `src/Host/WindowGeometry.cs`：纯函数 `WindowGeometryClamp.Clamp(geometry, workArea)`。
  - 宽高夹到 [`MinWidth/MinHeight`=640×480, 工作区]；工作区更小时退化为整块工作区（超小屏）。
  - 左上角夹到「能完整放下窗口」的范围；非法宽高（≤0）用默认 1000×760；`long` 运算避免 `int.MinValue/MaxValue` 溢出；`Max` 原样保留。
- `MainWindow` 构造时读取 `settings.Window`：`WindowStartupLocation=Manual` → 夹紧 → 应用 `Left/Top/Width/Height`，`Max` 时 `WindowState=Maximized`。
- 工作区取 **WPF DIP 口径**（`SystemParameters.WorkArea` 优先；副屏/完全出屏回退虚拟屏幕范围）。**实测发现并修正了一个 DPI 单位 bug**：初版直接使用 Win32 `GetMonitorInfo` 的物理像素，在 200% 缩放下 `Left=9000` 会被“夹紧”到双倍 DIP（物理坐标落到屏幕外）；改为 WPF DIP 后 `saved=(9000,9000)` 被夹到工作区内且往返稳定。
- `Closing` 时用 `RestoreBounds` + `WindowState==Maximized` 写回 `settings.Window`；写盘失败只记日志。
- 离屏自检窗口（`--verify-render/--verify-pdf`）设置 `SuppressGeometryPersistence`，避免把 `-32000` 写进用户设置。

**测试**
- `tests/host/WindowGeometryClampTests.cs`（12）：完全在屏、部分出屏、全部出屏、超小屏、负坐标（含副屏）、极端坐标不溢出、过小尺寸、非法尺寸、最大化保留。
- 300 次全量宿主测试通过。

**实测证据（真实 exe，ASCII 临时目录 + `JJ_DATA_DIR` 隔离）**
- 恢复往返：两次启动/关闭后 `settings.window` 稳定为 `{"x":49,"y":49,"w":1000,"h":760,"max":false}`，debug.log：
  `恢复窗口几何 saved=(49,49,1000,760,max=False) workArea=(0,0,1920,1040) applied=(49,49,1000,760)` → `保存窗口几何 (49,49,1000,760,max=False)`。
- 出屏恢复：预置 `window={"x":9000,"y":9000,...}`，启动后 applied `(920,508,1000,760)`（落在该次 WPF 工作区内），关闭后写回同一值。

### 2. I2 单实例转交激活

**改法**：`App` 的 IPC 回调两个分支（空串/有路径）统一先 `window.BringToForeground()`（最小化 → Normal、`Show()`、`Activate()`、`Focus()`），有路径再 `OpenDocument(path)`；空串分支不再只 `Activate`。

**测试/证据**
- 现有单实例测试（`IpcTests`）全绿。
- 真实 exe 实测：主实例启动 `hello.md` → 最小化（`IsIconic=True`）→ 第二实例转交 `full-syntax.md` → 第二实例 `exit=0`，主窗口 `IsIconic=False`，标题变为 `full-syntax.md — 鲸鲸阅读器`。

### 3. I3 WebView2 运行时缺失/初始化失败对话框（spec §5.11）

**改法**
- 新增 `src/Host/WebView2StartupFailure.cs`：纯函数 `BuildDialogModel(Exception)` 返回标题/说明/异常摘要/下载地址（`https://developer.microsoft.com/microsoft-edge/webview2/`）/数据目录/三个按钮文案，并识别异常链里的 `WebView2RuntimeNotFoundException`（含包装）。
- `MainWindow.OnLoaded` 捕获初始化异常 → 写日志 + 弹**原生 WPF 对话框**（说明、异常摘要、「下载 WebView2 运行时」、「打开数据目录」、「关闭」）。
- **选择：关闭后显示 WPF 解释页并保持窗口可用（不退出码 3）**——WebView2 不可用时连 `NavigateToString` 都无法渲染，解释页必须由 WPF 控件承载；退出码 3 保留给命令行自检语义。已在源码注释记录。
- 命令行自检设置 `SuppressFailureDialog`，不弹模态框；初始化失败直接 `Shutdown(2)` 快速失败。

**测试**
- `tests/host/WebView2StartupFailureTests.cs`（4）：运行时缺失、包装异常、其它初始化失败、null。
- 对话框/解释页为 WPF 交互，需手测（见清单）。

### 4. I4 全局异常兜底

**改法**
- `App` 构造注册 `DispatcherUnhandledException`、`AppDomain.CurrentDomain.UnhandledException`、`TaskScheduler.UnobservedTaskException`：
  - 全部把**完整异常（含堆栈/InnerException）**写入 `DebugLog`；
  - UI 线程非致命异常 `e.Handled=true` 并只弹一次 toast「发生内部错误，已记录日志，可以继续阅读」；`OutOfMemory/StackOverflow/AccessViolation` 视为致命不吞；
  - 后台异常只记录（进程即将终止）；未观察 Task 异常 `SetObserved()`。
- `SingleInstance.TryAcquire` 捕获 `UnauthorizedAccessException` → **退化为 `Local\` 命名空间重试**（同会话仍单实例）；`Global`/`Local` 都失败时按「单实例失效」继续启动（记日志，绝不崩溃）。管道名改为跟随 `EffectiveMutexName`，与 `IpcServer` 同源。
- 离线自检窗口不弹 WebView2 模态框（见 I3）。

**测试**：`SingleInstanceTests`（Global→Local 映射、PipeName 同源、非法名）；全局异常处理器为平台回调，需手测（可用调试构建临时抛异常验证日志/ toast）。

### 5. §5.11 编码异常提示 + load.encoding

**改法**
- `FileHost.Decode` 返回第 5 个字段 `HadReplacement`：严格 UTF-8 失败后仍按 GB18030 **严格**解码；严格 GB18030 失败时用宽松 GB18030 兜底并标记 `HadReplacement=true`（宽松 UTF-8 兜底同样标记）。有效 UTF-8 / 有效 GB18030 / BOM 不误报。
- `DocumentRead` 末尾新增 `bool HadReplacement = false`（位置参数带默认值，向后兼容）。
- `Protocol.Load` 增加 `encoding`（默认 `utf-8`，旧调用兼容）。
- 新增宿主→前端 `Protocol.Notice(text, level, persistent=true)`：
  - 文件打不开 → toast + 持久 notice（error）；
  - 二进制拒绝 → toast + 持久 notice（warn）；
  - `HadReplacement` → 持久 notice「文件编码可能不是 UTF-8，部分字符已替换」。
- 前端 `#error-bar` 消费 notice（见前端第 9 条）。

**测试**
- `tests/host/FileHostEncodingTests.cs`（5）：合法 UTF-8/GB18030 不误报、非法字节标记替换、二进制不标记、`ReadDocument` 透传。
- `tests/host/ProtocolNoticeTests.cs`（6）：notice 字段/默认值、settings 序列化、load.encoding（显式 + 默认）。
- 真实 exe 实测：写入 `FF 41 0A` 的坏编码文件，`--verify-render` 成功，debug.log：`load path=... encoding=gb18030 ... hadReplacement=True`。

### 6. M2 debug.log 滚动

**改法**
- `DebugLog`：单文件超过 **256 KB** 滚动为 `debug.log.1`、`debug.log.2`，最多 **3 份**（删除更旧）；滚动/写盘失败静默；新增 `WriteTo(path, message)` 供测试注入路径。
- `MainWindow.SavePosition`：同一文档只写第一条日志（ratio 仍逐次落盘），切换文档后重新记录首条。

**测试**：`tests/host/DebugLogTests.cs`（5）：写入/时间戳、超限滚动、最多 3 份、空路径/不可写路径静默。

### 7. C1 关联收尾（有效默认程序 / UserChoice）

**改法**
- 新增 `src/Host/EffectiveAssociation.cs`：`Resolve(registry)` = `FileExts\.md\UserChoice\ProgId` 非空白优先，否则回退 `Classes\.md` 默认；`IsJingjingReaderDefault`。
- `Assoc.GetState` 改用有效默认。
- `Assoc.Install`：仅当**有效默认不存在**时才写 `Classes\.md` 默认值（UserChoice 指向别的程序时不再写自己的 Classes 默认）。
- `Assoc.UninstallDetailed`（新）+ `Uninstall` 保留原签名：卸载前读取 UserChoice，若仍为本 ProgID 返回 `UserChoiceNeedsReselect=true`；**不删除/不改写 UserChoice**，Classes/OpenWithProgids 仍按备份恢复。
- `App --uninstall`：命中时输出明确警告 + `ms-settings:defaultapps` 提示，**退出码仍为 0**（不视为失败）。
- `README` 与 spec §5.9 措辞改为「Classes 与打开方式可完整恢复；Windows UserChoice 需用户在默认应用中重新选择」。

**测试**
- `tests/host/EffectiveAssociationTests.cs`（8）：UserChoice 优先、空白/缺失回退、无关联返回 null、默认判断（大小写）、null 参数。
- `tests/host/AssocUserChoiceTests.cs`（6）：UserChoice 指向他程序时不写 Classes 默认、无 UserChoice 时写入、保留已有 Classes 默认、卸载警告标志且不动 UserChoice、警告不误报、损坏备份不误标。
- 既有 `AssocTests` 全绿（`Uninstall` 兼容入口不变）。

### 8. 验收隔离（`JJ_DATA_DIR`）

**改法**
- `AppPaths.DataDir`：显式设置 `JJ_DATA_DIR` 时使用该目录（相对值按当前目录转绝对；非法值回退默认），否则生产默认 `%APPDATA%\JingjingReader` 不变。
- 新增 `AppPaths.WebViewDataDir`（数据目录下 `WebView2`），`MainWindow` 的 WebView2 userDataFolder 改用它；`assoc-backup.json`、`debug.log` 同步受影响。
- README 增加「测试用隔离变量」一句；**未修改 `scripts/verify.ps1`**（下一波接入）。

**测试**：`tests/host/AppPathsTests.cs`（5）：默认路径、覆盖、非法回退、环境变量真实生效、空值回退。

**实测证据**：ASCII 临时目录复制 `out\`，设置 `JJ_DATA_DIR` 后跑 `--verify-render hello.md`：exit 0 + READY，隔离目录生成 `debug.log` 与 `WebView2\`，`%APPDATA%\JingjingReader\debug.log` 的 LastWriteTime **未变化**。

## 前端

### 9. §5.11 渲染异常兜底 + 错误条

**改法**
- shell 新增 `#notice-stack`（固定于工具条下方，z-index 28 低于工具条 30）：内含 `#error-bar[role=alert]`（可关闭、持久）与 `#huge-banner`；light/dark 两套 CSS 变量。
- `render.js`：`render()` 整体 try/catch → `renderFallback(markdown)`（转义 `<pre class="jj-fallback">`）+ 错误条；引擎缺失也显示错误条。`renderLoad` 外层再兜一层并**照常发送 `renderDone`**。
- 分块：`chunk.js` 单块 `render` try/catch → 该块输出转义 `<pre class="jj-fallback">`，`onChunkError` 通知 shell 显示错误条，**后续块继续渲染**；`renderAll` 路径同样覆盖。
- `onMessage` 整体 try/catch（坏消息降级为错误条）；boot 的消息监听改为 `dispatchWebMessage(shell, data)`（index.js 导出，内部 try/catch + console.warn）。
- `notice` 消息：`persistent !== false` → 可关闭错误条（level 映射 warn/error）；`persistent === false` → 兼容为 toast；新 `load` 自动收起上一份错误条。

**测试**（`tests/web/shell-errors.test.js`）
- `renderMarkdown` 抛错 → `<pre>` 兜底、原文按文本展示（`<script>` 不执行）、错误条可见、`renderDone` 仍发送；
- 分块单块抛错 → 失败块纯文本 + 第三块仍渲染 + 错误条；
- notice 持久显示/关闭/新 load 收起；notice.persistent=false → toast；
- `onMessage` 抛错被捕获、`dispatchWebMessage` 兜底。

### 10. I3 PDF 导出等待图片/字体

**改法**：`print.js` 新增 `waitForPrintAssets`（导出上限 `PRINT_ASSET_WAIT_MS=2000`）：
1. 所有 `img` 的 `loading` 置 `eager`；
2. 等待每张图 `complete` / `load|error` 后 `img.decode()`（decode 失败忽略）；
3. 等待 `document.fonts.ready`（可选，jsdom 无则跳过）；
4. `body.offsetHeight` 强制 reflow。
`enterPrintModeForPdf` 改为 async：进入打印模式后等待资源（整体最多 2s，超时继续）再发 `readyToPrint`；返回 Promise 供测试等待。

**测试**（`tests/web/print.test.js` +2，另 3 个旧用例改为 await）
- fake timers：未完成图片 → 断言已进打印模式但 `readyToPrint` 尚未发送、`loading` 已改 eager；2s 超时后照常发送；
- 图片在窗口内 `load` → 立即发送，不等满 2s。

### 11. I5 sanitize fail-open

**改法**：`getPurifier` 在 `instance.isSupported === false` 时返回 `null`（`sanitizeHtml` 返回空串），首次 `console.warn`；新增 `__setPurifierFactoryForTest` 测试注入点（仅测试用）。

**测试**：`tests/web/sanitize-unsupported.test.js`（2）：`isSupported=false` → 空串 + 只告警一次；恢复真实工厂后正常清洗。

### 12. 分块结构保护（I2）

**改法**（`web/src/chunk.js`）
- 表格：把 `^\s*\|?\s*:?-{3,}` 分隔行 + 连续含 `|` 行（含无前导 `|` 的 GFM 表格）标为原子块；已标记表格跳过，避免连续分隔行 O(n²)。
- 围栏：结构判定前剥离最多 3 层 `>`、列表项缩进/任务清单前缀；引用/列表内围栏可识别，且**不在嵌套围栏起始行前切块**（避免把围栏从容器里撕出来）。
- HTML 块：块级开标签（div/table/section/details/pre/ul/ol/blockquote/figure/script/style…）到空行整块不切。
- fetch front matter：`frontMatterLineCount` 改用引擎 `extractFrontmatter` 校验；无效 YAML（正文未被剥离）不视为惰性块，避免首块超预算。
- 单块渲染失败兜底（见第 9 条）。

**测试**（`tests/web/chunk-structure.test.js` 9）
- ~100KB 无前导 `|` 表格整块（blocks=1）；~100KB `>` 引用内围栏整块且围栏配对平衡；列表内/嵌套引用+列表围栏整块；HTML 块整块；HTML 块空行后仍可切；无效 YAML 可切且 join 一致；有效 YAML 仍原子；表格与普通段落混合不误伤；全部 `blocks.join('')===md`。

### 13. huge 模式持久横幅

**改法**：`#huge-banner`（`role=status`，固定于通知栈内）随 `applyHugeMode(true)` 显示，可关闭；切回普通文档自动隐藏；保留原 3 秒 toast 作即时提示。

**测试**：`shell-errors.test.js`：大文件 → 横幅可见/可关闭；普通文档 → 隐藏。

### 14. 空白启动「打开文件」按钮

**改法**：`renderRecent` 新增 `.recent-open`「打开文件…」按钮（`onPickFile` 回调），空白启动页与工具条最近菜单都发 `pickFile`。

**测试**：`shell-errors.test.js` 断言按钮存在且点击发 `pickFile`。

### 15. 分块 TOC 空 slug 死链

**改法**：`render.js` 新增 `ensureHeadingIds`，在 `renderToc`/渲染前给 `extractHeadings` 中空 slug 条目分配 `section-N`（先登记全部真实 id，避免与真实 `section-1` 撞车）；一次性渲染把同一列表作为 `tocHeadings` 传给引擎，使 `[TOC]` 内联目录与侧栏 href 一致。

**测试**：`shell-errors.test.js`（强制分块）：`## section 1` + `## ！！！` → 侧栏/内联目录 href 均为 `#section-1`/`#section-2`，正文 h2 id 一致，无 `href="#"`。

### 16. splitBracketed O(n²)（DoS）

**改法**：`ext/web/util.js` 只按同一份源码缓存「换行位置 + `]]` 位置」有序数组（一次 O(n) 扫描），每次查询二分；单行 label 上限 2000 字符；无匹配不再扫到文档末尾。

**测试**：`tests/web/ext-util.test.js`（7）：目标/别名、跨行、maxPos、超长 label、非法参数、**`'[[x'.repeat(5000)` 整篇渲染 <100ms**（宽松阈值防 flaky）。

### 17. 工具栏键盘可达性（最小）

**改法**：`#toolbar`/Aa 面板/最近菜单 `focusin` → 显示工具条；自动隐藏到点时若焦点仍在工具条/浮层内则保持可见；`focusout` 离开后再按 800ms 规则隐藏。新增 `Alt+T` 主题三态循环、`Alt+A` 关于；README 快捷键表同步。

**测试**：`shell-errors.test.js`：焦点进工具条后鼠标移出 900ms 仍可见；Alt+T 切到浅色并发 saveSettings；Alt+A 发 openAbout。

### 18. 空白启动应用持久设置

**改法**：宿主 `shellReady` 后新增 `settings` 消息（`Protocol.Settings(AppSettings)`，payload 为 camelCase AppSettings）；前端 `settings` 分支在未打开文档时也 `normalize` → `applySettings/applyTheme`/侧栏/Aa 回显。

**测试**
- 宿主：`ProtocolNoticeTests` 断言 `settings` 序列化；
- 前端：`shell-errors.test.js`：空白启动收到 `settings{theme:'dark',fontSize:20}` 后 `data-theme=dark`、`--font-size:20px`。

### 19. 分块 front matter 校验

与第 12 条同批实现与测试（无效 YAML 不再造成首块超预算）。

## 需要手测的清单

1. **I1 窗口几何**：正常启动 → 移动/缩放/最大化 → 关闭 → 重开，位置/大小/最大化保持；最大化时还原尺寸正确；改分辨率/拔掉副屏后重开，窗口仍完整落在可见工作区内（多显示器负坐标）。
2. **I2 单实例**：主实例最小化后双击另一个 `.md` → 窗口还原、显示新文件；无参数再启动 → 只还原激活、不换文档。
3. **I3 WebView2 缺失**（勿在验收机真的卸载运行时；建议 VM）：改名为缺失/用受限用户 → 启动弹出原生对话框；「下载 WebView2 运行时」打开官方页；「打开数据目录」打开 `%APPDATA%\JingjingReader`；关闭后显示 WPF 解释页且进程不崩、不残留模态框。
4. **I4 全局异常**：调试构建临时在 UI 事件中抛异常 → 完整堆栈进 debug.log、只弹一次 toast、阅读不中断；后台 Task 未观察异常不导致进程崩溃；受限账户（Global mutex 无权限）启动可用（Local 退化）。
5. **§5.11 错误态**：打不开的文件/二进制文件/坏编码文件 → 顶部错误条持续可关闭，正常打开新文件后消失；错误条不遮挡工具条（浅/深主题）。
6. **M2 日志**：长时间滚动阅读，debug.log 不再每 500ms 增长；>256KB 后出现 `.1/.2`，最多 3 份。
7. **C1 关联**：`--install`（UserChoice 指向 Typora 时）不写 Classes 默认；`--uninstall`（UserChoice=JingjingReader.md）输出警告且 exit 0，打开 `ms-settings:defaultapps` 可重新选择；备份损坏时仍报错不改注册表。
8. **PDF**：含 lazy/网络图片的文档导出，图片不被漏掉；离线图片占位不导致导出卡住（2s 上限）。
9. **大文件横幅**：>20MB 文档顶部横幅常驻、可关闭；切到普通文档自动消失。
10. **分块 TOC 死链**：纯标点标题/重复标题的 TOC 与 `[TOC]` 点击能定位。
11. **快捷键/可达性**：`Alt+T`、`Alt+A`；Tab 进工具条后工具条不因鼠标移出而消失、Esc 关闭浮层。
12. **隔离变量**：`JJ_DATA_DIR` 下正常启动/关闭/最近文件/位置记忆均写隔离目录（自动化已覆盖 `--verify-render` 路径）。

## 决策与遗留

- **I3** 选择「解释页」而非退出码 3（原因见上）；源码与报告均已记录。
- **I5** 选择新增 `DocumentRead.HadReplacement`（不改既有 `EncodingName` 语义，向后兼容）。
- **I4** SingleInstance 选择「Local\ 退化重试」，两者都失败时按单实例失效继续启动（保证程序可打开）。
- **未修改 `scripts/verify.ps1`**：`JJ_DATA_DIR` 已具备，下一波接入隔离。
- 既有宿主 313 / 前端 384 tests 全部保留通过，安全波 A（C1/C2）行为未回退。
