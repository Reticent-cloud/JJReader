# SDD ledger — plan: docs/superpowers/plans/2026-10-17-jingjing-reader.md

Spec: docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md（已读，为本计划绑定权威）
Worktree: D:\dsh-work\MD阅读器\.worktrees\feat\jingjing-reader（branch feat/jingjing-reader）
Workspace: D:\dsh-work\MD阅读器\.worktrees\feat\jingjing-reader\.superpowers\sdd\2026-10-17-jingjing-reader

## Pre-flight scan（启动前冲突扫描）

### 跨任务：共享文件/接口

| 任务对 | 共享面 | 一个产出 vs 另一个消费 | 结论 |
|---|---|---|---|
| T1 ↔ T4 | `web/src/index.js` | T1 写 `window.JJ={version}`；T4 改为 `install(target)` 导出 | 无冲突：T4 合法重写该文件（已在 T4 Files 的 Modify 中） |
| T1 ↔ T5–T8 | `web/package.json` 依赖 | T1 按 Global Constraints 锁全部依赖版本；T5–T8 使用 markdown-it/插件/DOMPurify/hljs | 无冲突，T1 必须一次锁全 |
| T3 ↔ T4/T8/T9 | `FileHost.VirtualHostUrl` / `baseUrl` | T3 生成 `https://md.local/<转义相对路径>`；T8 附件 `src`、T9 图片占位均基于该 baseUrl | 无冲突 |
| T4 ↔ T10/T12/T13/T14/T15 | 消息协议 14 条 | T4 定义契约；后续任务按契约发消息 | 无冲突（T14 的 listDir/dirListing、T15 的 readyToPrint、T13 的 pickFile/pickFolder 已在 T4 契约中） |
| T5 ↔ T9/T10 | `renderMarkdown` / `extractHeadings` | T5 产出签名；T10 需要给 heading 补 `top` | 无冲突：`top` 由 shell 从 DOM `offsetTop` 采集，不改 T5 签名 |
| T6 ↔ T9 | `web/src/enhance.js` | T6 建 enhance（复制按钮）；T9 扩展（图片占位） | 无冲突（T9 Files 已列 Modify enhance.js） |
| T7 ↔ T8/T9 | 清洗白名单 | T8 依赖 `data-target`；T9 依赖 `<nav class="toc-inline">` 与 `data-level` | **冲突**：T7 白名单缺 `nav` 与 data-* → 见 R1 |
| T4 `mountShell` ↔ T15 打印 | `JJ.__post` | T15 的 `enterPrintModeForPdf` 需要 mountShell 存下的 post | 无冲突（T15 Files 已列 Modify shell/main.js） |
| T11 ↔ T17 | `samples/huge-50k-lines.md` | T11 用 gen 脚本产出；T17 verify 使用 | 无冲突（生成脚本 T17 创建，T11 Step4 先手动生成） |
| T4/T9/T11 ↔ T17 | `samples/*.md` | verify 需 `hello.md`(T4)、`full-syntax.md`(?)、`huge-50k-lines.md` | **缺口**：`full-syntax.md` 无归属 → 见 R2 |
| T2/T3/T13/T16 ↔ tests | `TestDir()` 辅助 | 多个宿主测试类都要临时目录 | **缺口**：未定义公共测试辅助 → 见 R3 |
| T4 ↔ 全部前端测试 | vitest 配置 | 测试用例用全局 `it/expect/vi` | **缺口**：未写 `globals: true` → 见 R4 |
| T10 ↔ Global Constraints | 行宽 4 档含「全宽」 | 接口只列 640/780/960 | **歧义**：全宽如何编码 → 见 R5 |

### 单任务自洽

| 任务 | 检查点 | 结论 |
|---|---|---|
| T1 | SelfTest 测试引用 `JingjingReader.SelfTest`；RootNamespace 默认同名 | 自洽 |
| T2 | ComputeKey 大小写不敏感测试与实现一致（小写化后哈希） | 自洽 |
| T3 | `VirtualHostUrl` 转义断言与实现（Uri.EscapeDataString 逐段）一致 | 自洽 |
| T4 | shell-boot 测试断言 `#content` 与 `renderDone`；mountShell 骨架含该节点 | 自洽 |
| T5 | `extractHeadings` 返回无 `top` 字段，与 T10 测试入参不矛盾 | 自洽 |
| T6 | `data-code` 由 enhance 直接设 DOM 属性，不经清洗 | 自洽 |
| T7 | 白名单含 `input type/checked/disabled`（任务清单所需） | 自洽 |
| T8 | 附件 `![[图 1.png]]` 转义断言 `%E5%9B%BE%201.png` | 自洽 |
| T9 | `[TOC]` 生成 `<nav class="toc-inline">` → 依赖 R1 | 受 R1 约束 |
| T10 | 主题/排版/scrollSpy 测试签名与 Produces 一致（headings 带 top） | 自洽 |
| T11 | `blocks.join('')===markdown` 与表格不切分断言相容（纯切片） | 自洽 |
| T12 | `createPositionTracker` 测试去掉 path 参数与 Produces 一致 | 自洽 |
| T13 | `IpcServer.Start(pipe, cb)` 双参重载与 App 调用一致 | 自洽 |
| T14 | `renderTree` 的 `post` 作可选注入，测试与实现一致 | 自洽 |
| T15 | `enterPrintModeForPdf` 依赖 `JJ.__post`；测试先 mountShell | 自洽 |
| T16 | `Assoc.Uninstall` 备份恢复与 Install 的备份结构对应 | 自洽 |
| T17 | perf 测试 dist 路径 `../../web/dist/md-engine.js`（tests/web → web/dist） | 自洽 |

## Rulings

- R1（T7）：清洗白名单必须额外允许标签 `nav` 与属性 `data-target`、`data-level`（`ALLOW_DATA_ATTR:false` 前提下显式加入），否则 T8 的 wikilink/附件与 T9 的内联目录会被剥掉。代价若错：wikilink 与 `[TOC]` 失效，返工成本约半小时；优于改 T8/T9 方案。
- R2（T9）：`samples/full-syntax.md` 由 T9 创建（覆盖 spec §5.7 语法矩阵逐条），供 T10 人工核对与 T17 verify 使用。代价若错：验收缺样例，补做 10 分钟。
- R3（T2）：`tests/host/TestHelpers.cs` 提供 `static string TestDir()`（建临时目录并登记清理），由 T2 创建，T3/T13/T16 复用。代价若错：辅助重复实现，无害但冗余。
- R4（T4）：`web/vitest.config.mjs` 必须设 `globals: true` 与 `setupFiles: ['../tests/web/setup.js']`，否则测试文件无法直接用 `it/expect/vi`。代价若错：测试报未定义，立即发现。
- R5（T10）：`contentWidth` 用 0 表示「全宽」（CSS `--content-width: 100%`），其余取 640/780/960。代价若错：全宽档缺失，属 Minor。
- R6（T1）：`web/src/index.js` 在 T1 只需最小 `install()` 骨架（T4 会补 mountShell），避免 T4 大改结构。代价若错：T4 重写，无实际成本。

## Task log

## Task 1
- Review 1: [FAIL] 1 Important（build.mjs 缺 CSS loader/内联注入，plan-mandated）
- Task 1: fix round 1/5 (1 addressed, 0 open — CSS loader/banner/applyCss；commits a3f4680..86dc13a)
- Task 1: complete (commits fab9c53..86dc13a, review clean)
- Task 1: minor (deferred): package-lock 全部 resolved 固化华为云镜像；npm test 在 T1 会因无测试文件退出码 1；SelfTestTests.Run 只断言前缀、注册表 GUID 错误无回归保护；ConsoleHelper 编码修复无自动化测试（建议 T17 verify 加 UTF-8 断言）；build.ps1 Invoke-Step 读 $LASTEXITCODE 前未初始化；build.ps1 publish 前未清理 out/
- Task 1: carry-forward（来自 re-review 的 out-of-scope）：T10 注意 styles 的字母序拼接（base,code,dark,layout,light,print）与计划文档顺序不同，且不要依赖 base/layout/code 之间的跨文件级联；T10 需把 applyCss 暴露到 JJ API（T6/T10 复用）

## Task 2
- Task 2: complete (commits 86dc13a..dc7c96f, review clean — Approved，无 Critical/Important)
- Task 2: minor (deferred): Save 失败时 .tmp 残留未清理；catch(Exception) 把瞬时 IO 错误当损坏并改名备份；备份名秒级碰撞会把坏文件留在原地；Load 侧未夹紧 FontSize/LineHeight/ContentWidth/TocWidth/ratio；LoadRecent 不按时间排序（与 LoadPositions 不对称）；Load 侧 caps 与 PropertyNameCaseInsensitive 无测试；固定 .tmp 名并发写不安全（T13 必须串行写盘）
- Task 2: Ruling: spec §5.5/§6.3 的 monoFont 未进 brief 的 AppSettings —— 由 T10（排版面板）在修改 src/Host/Store.cs 时补 `string MonoFont = "consolas"`（record 末尾加默认参数，向后兼容）；代价若错：字体偏好无法持久化，属 Minor 返工
- Task 2: Ruling: 行宽「全宽」编码沿用 R5 —— contentWidth = 0 表示全宽（CSS `--content-width: 100%`），T10 实现并在 T10 测试中覆盖；代价若错：全宽档不可用

## Task 3
- Review 1: Approved，1 Important（百分号编码引用二次编码，plan-mandated 契约歧义）
- Task 3: Ruling: VirtualHostUrl 对引用先 Uri.UnescapeDataString 再逐段转义（非法转义不抛、docPath 不解码）——代价若错：图片路径语义偏移，可快速回退
- Task 3: fix round 1/5 (1 addressed, 0 open — 46/46 FileHost、57/57 全量；commits 6f859bc..ee815ef)
- Task 3: complete (commits dc7c96f..ee815ef, review clean)
- Task 3: minor (deferred): UTF-16LE 测试 fixture 不含 NUL 故未真正验证 BOM 优先于二进制；`/img/x.png` 根相对引用落兜底产生 `//`；越界兜底 URL 仍含 `..`（T9 以加载失败兜底）；VirtualHostUrl 未复用 NormalizePath；无权限读测试缺失；Key.Length==40 断言耦合 SHA-1；GB18030 兜底 catch 不可达
- Task 3: carry-forward：T4/T9 生成图片 URL 统一走 VirtualHostUrl，不要用 ResolveInside 校验已编码引用

## Task 4
- Task 4: complete (commits ee815ef..8793726, review clean — Approved，无 Critical/Important)
- Task 4: 过程缺陷：控制器漏生成 task-4-brief.md，实现者按计划+10 条决策完成；brief 已补生成，评审已按 brief+决策核对
- Task 4: minor (deferred): 只转义 `</script` 未处理 `<!--`+`<script`（T5 起建议 build.mjs 加产物断言）；`\?\` 剥离分支无测试（T13/T17 实测）；verify-render 文件不存在要等满 15s（T17 前置预检）；savePosition 不校验 key 相等/ratio 夹取（T12 定契约）；bootWebViewShell 与 Dispatch/savePosition 粘合层无单测；ClearVirtualHostNameToFolderMapping catch 范围与 TryMap 不一致；MainWindow 无 Closed 显式 Dispose；verify 的 elapsedMs 取整后为 0；vitest config 的 server.fs.allow:['..'] 为必需（勿删）；debug.log 无滚动（T17 按 spec 3×256KB）
- Task 4: carry-forward：T17 verify.ps1 必须先把 out\JingjingReader.exe 复制到 %TEMP% 再跑（沙箱下 workspace 内 exe 写 %APPDATA% 被拒，实测 0x800700AA）；T12 前端只报最新 load 的 key、宿主校验；T17 用 >255 字符路径实测 \?\ 分支

## Task 5
- Task 5: Ruling: brief 用例 `## 二级##` 在 CommonMark 不成立（尾井号需前置空格），实现者改用 `## 二级 ##`，期望正则不变——接受；代价若错：无（意图保留）
- Task 5: Ruling: shell-boot 两处断言按决策 6/7 更新（tocCount 0→1、HTML 透传改兜底）——接受，未削弱 T4 契约
- Task 5: complete (commits 8793726..8199c21, review clean — Approved，无 Critical/Important)
- Task 5: minor (deferred): 纯标点标题空 slug 的第二个 id 变 `-2`（T10 锚点需兜底）；shell 注释承诺的异常兜底未覆盖 renderMarkdown 抛错；baseUrl 尾斜杠未归一化；elapsedMs 含第二次 parse（T11 处理）；env 不污染/breaks/typographer 无用例；JJ.slugify 额外公开；shell 层 XSS 断言待 T7 补
- Task 5: carry-forward：产物 259KB，T6 加 hljs 后接近 350KB，超 500KB 门限时的裁决见 T6 派发说明

## Task 6
- Task 6: Ruling: markdown-it 表格对齐输出 style="text-align:*" 而非 align 属性 —— 保持默认，改断言（T7 白名单允许 text-align）；代价若错：属性样式差异，无功能影响
- Task 6: Ruling: 未压缩产物 533KB 超 500KB 门限 → 启用预授权 minify:true，产物 291.5KB（298468 B）；语言注册实为 15 个（决策枚举名单），接受；代价若错：调试时产物不可读，可临时关 minify
- Task 6: complete (commits 8199c21..f54a4b2, review clean — Approved，无 Critical/Important)
- Task 6: minor (deferred): shell 调 enhance 未包 try/catch（若 enhance 抛会中断 renderDone）；外链 rel 覆盖而非合并；fence class 用原始 info 未归一化；三处 escape 实现重复；注入用例未含字面 </button>；别名测试覆盖不全；fence 高亮无大小上限
- Task 6: carry-forward（关键）：T7 白名单必须放行 `button`+`data-code`（否则复制按钮被剥）、T8 的 `data-target`、T9 的 `nav`+`data-level`；T13 处理 target=_blank 的 NewWindowRequested；T11 关注 hljs 首次高亮开销与超长代码块

## Task 7
- Task 7: complete (commits f54a4b2..b1e827a, review clean — Approved；对抗性探测无 XSS)
- Task 7: Ruling: `SAFE_FOR_XML:false` 保留（为 data-code 保真；唯一 sink 是 innerHTML，白名单排除 svg/math/template/noscript）— 代价若错：noscript/title 属性原文保留，需 T9/T10 禁止把输出拼进属性/模板
- Task 7: Ruling: `data:image/svg+xml` 按决策字面放行（href 亦然），因本地阅读器无外开链路、风险低 — 代价若错：点击 SVG data URI 链接的安全面扩大，可收紧
- Task 7: minor (deferred): id 的 DOM clobbering（`id="title"` 被剥）需 T10 渲染后重赋 id；协议相对 `//host`/`\host` 放行未记录；isSupported:false 时未失败关闭；sanitizeHtml 对 null 参数抛 TypeError；测试未覆盖大小写/实体/空白协议变体与 data:image/svg+xml；target/rel 原样放行
- Task 7: carry-forward（关键）：T10 必须在渲染后按 extractHeadings 顺序重赋 heading id（querySelector 兜底无效，属性已删）；T9/T10 禁止把 renderMarkdown 输出拼进属性/模板

## Task 8
- Task 8: complete (commits b1e827a..f998f4a, review clean — Approved，无 Critical/Important；166 tests)
- Task 8: Ruling: 接受实现者自定口径（附件别名 alt/链接文本、无效 frontmatter 返回空 data+原文 body、`%%` 紧贴数字/`%` 不算注释起点、外链内 wikilink 字面文本）；代价若错：罕见文档形态表现不同，可后续修
- Task 8: Ruling: 接受计划外 `web/src/ext/util.js`（共用切分工具，无额外功能）；代价若错：文件清单歧义
- Task 8: minor (deferred): frontmatter 块内 `#` 行被当 YAML 注释跳过导致「整块剥离」与报告口径不符；env 写回使 env 一次性（复用会陈旧，T9 必须每次新建 env）；注释紧贴数字会原样显示（缺正向用例）；附件名含 `#`/`?` 时 URL 被当 fragment（沿用既有 renderer）；frontmatter 每次渲染解析两次；若干覆盖缺口
- Task 8: carry-forward：T9 每次渲染必须新建 env 字面量，不要复用；T9 展示 frontmatter 用 extractFrontmatter 而非复用 render 的 env

## Task 9
- Review 1: [FAIL] Critical —— `hasTocPlaceholder` 正则灾难性回溯，engine 对每个文档无条件调用（"> "×32 卡 12s）
- Task 9: fix round 1/5 (1 addressed, 0 open — 逐行扫描替代正则；194 tests；commits 8769815..213d9ed)
- Task 9: complete (commits f998f4a..213d9ed, review clean；M2 语法完整里程碑达成)
- Task 9: minor (deferred): 预扫描与块规则对列表项内 `[TOC]` 的命中仍不一致（既有行为）；ReDoS 回归测试失败表现为挂起而非干净红；`onImageError` 只在首次 enhance 生效；TOC 转义缺专项用例；报告数字失准；占位框视觉依赖 T10 CSS
- Task 9: carry-forward（关键）：T10 必须在渲染后按 extractHeadings 顺序**重赋 heading id**（DOMPurify clobber）；T10 加 `.toc-inline`/`.img-placeholder`/`.frontmatter` 的 CSS

## Task 10
- Task 10: Ruling: spec §5.1/Global Constraints 的「TOC 可拖 180–360」未进 brief 步骤 → 追加提交 bf14a05 补齐（resizer.js + 测试）— 代价若错：无
- Task 10: Ruling: 决策 11「三栏网格」实际为「两列 grid + fixed 悬浮工具条」——功能等价，接受 — 代价若错：布局重构，Minor
- Review 1: [FAIL] 1 Important —— TOC top 快照不随重排刷新，点击/高亮错位；10 Minor（main.js 923 行需 T12 前拆分、destroy 不解除 theme 订阅、无 setPointerCapture、settingsPatch 浅比较、tocCount 只数 markdown 标题、Store 缺旧文件向后兼容用例、深色硬编码色、isEditableTarget 过宽、renderLoad 不重置 scrollTop 等）
- Task 10: fix round 1/5 (1 修复中 — refreshHeadingTops + 点击实时定位 + spy 抗非单调；commit a4988b7)；re-review 已派发（上一次调用被运行时中断，结果未知，已重试）
- Task 10: fix round 1/5 (1 addressed, 0 open — refreshHeadingTops 覆盖五个时机、点击实时 offsetTop、spy setHeadings+线性扫描抗非单调；58 shell-ui 用例；commits bf14a05..a4988b7；复评：无新 Critical/Important)
- Task 10: complete (commits 213d9ed..a4988b7, review clean after 1 fix round)
- Task 10: minor (deferred): main.js 923 行（T12 前应拆 Aa 面板/工具栏/主题接线）；destroy 不解除 theme 模块订阅；拖拽无 setPointerCapture；settingsPatch 浅比较；tocCount 不含 raw HTML 标题；Store 缺旧 settings.json（无 monoFont）向后兼容用例；深色下 toast/复制失败态硬编码浅色；isEditableTarget 对 select 过宽；renderLoad 不重置 scrollTop（T12）；点开正文 details 不触发 refresh；三个新用例未先 flush 一帧（测试硬化）

## Task 11
- Task 11: implemented (commit b6061c6) — 283 web tests、93 宿主、huge 157ms/500 标题、hello 13ms
- Task 11: Ruling: 首屏预算按渲染 HTML 字节累计（非 markdown 源字节）——满足 brief 逐字用例且首屏更省；代价若错：分块模式首屏块数偏少（懒加载补偿）
- Task 11: Ruling: 接受 createChunkedRenderer 接口超集（onChunkRendered/observerRoot/destroy）、相邻标题段合并 64KB、huge toast 双发（宿主记日志忽略）、assignHeadingIds 重复 id 重配对；代价若错：接口文档需同步
- Task 11: Ruling: 2.6MB 生成样本 samples/huge-50k-lines.md 入库（T17 验收离线可复现）；代价若错：仓库体积 +2.6MB，可改由脚本生成
- Task 11: carry-forward：T12 派发时必须要求拆分 main.js（923+ 行，评审 T10 Minor）：抽出 Aa 面板/工具条/chrome；T12 需处理脚注/引用跨块限制（若评审要求）
- Review 1: [FAIL] 3 Important —— ①内联 [TOC] 分块模式死链（只侧栏绑 click）②跨块脚注/引用式链接定义失效（spec §5.7 语法在大文档静默退化）③renderAll 同步 + 每块全容器 enhance/assignHeadingIds 近 O(n²)（2.6MB jsdom 5971ms）
- Task 11: Ruling: ② 只修引用式链接（全文定义追加到各块，渲染无输出）；脚注跨块作为已记录限制（需处理编号/重复 section，成本高、>512KB 文档才触发）— 代价若错：大文档脚注显示为字面文本
- Task 11: Ruling: 首屏 HTML 字节口径、相邻标题合并、接口超集、样本入库、toast 双发、重复 id 重配对——均接受（评审独立核对通过）
- Task 11: fix round 1/5 派发中（3 Important + 阈值字节口径 + front matter 切点 + destroy/start）
- Task 11: minor (deferred): 首块无条件/原子块可击穿首屏预算；分块模式侧栏 TOC 丢内嵌 HTML 标题；destroy 后 start 不可达坑；CRLF/4+反引号/setext/无 IO/内联点击/huge 多块 缺自动用例；escapeHtml/escapeAttr 重复；huge-mode 挂 body 多实例互扰
- Task 11: fix round 1/5 (3 Important + 3 Minor addressed, 0 open — 内联 TOC 委托、引用定义追加、增量渲染 renderAll 5271→1714ms；commits b6061c6..9dc53ae)
- Task 11: complete (commits a4988b7..9dc53ae, review clean after 1 fix round)
- Task 11: minor (deferred)：引用定义续行收取过宽（缩进说明行会被并入并在每块重复渲染）；FM 内伪定义未跳过；未闭合围栏时定义被追加进代码块；内联目录空 hash 点击无反应；renderAll 仍同步全量（20MB 未测）；基准脚本已删不可复算；`:679` 用例 if(anchor) 空转风险
- Task 11: re-review verdict: All findings addressed, no new Critical/Important（4 条新 Minor 已记）
- M3 里程碑进行中：T10/T11 完成，Task 12 已派发（近期文件/位置记忆/工具条 + 必要宿主消息：recent/openFile/saveSettings/reload/showInFolder + SettingsPatch 纯函数）

## Task 12
- Task 12: implemented (commit 02de2b0) — web 323、host 124、main.js 1216→736 行（toolbar/recent/chrome/headings/render 拆分）；宿主新增 recent/reload + SettingsPatch/openFile/showInFolder
- Task 12: Ruling: 进度条必须是 spec §5.1 的「右侧 3px 竖向」——Controller 决策 4 的 width% 口径有误，按 spec 改（代价若错：仅 UI 方向）
- Task 12: Ruling: spec §5.6「工具条最近文件菜单」必须补（空白页与工具条共用列表）
- Task 12: Ruling: 分块/huge 文档位置恢复先 renderAll 再精确恢复（代价若错：大文档恢复多花 1–2s）
- Task 12: Ruling: 二进制文件不进最近列表（RecentPolicy.ShouldRecord 纯函数 + 单测）
- Task 12: 接受：启动时可能重复 recent 消息（前端幂等）；render.js 为行数目标的额外拆分
- Task 12: fix addendum 派发中（4 项裁定）
- Review 1: [FAIL] 2 Important —— ①分块文档保存侧 ratio 用已渲染高度作分母（恢复侧已修）→ 重开前跳约 4 倍 ②切文档 destroy 前不 flush 丢最后 ≤500ms 位置；8 Minor（最近菜单无焦点、Aa 滑杆每 input 落盘、position=0/不可滚动也提示、"正在恢复"toast 不可见、aria-valuenow、菜单提示 Ctrl+O 未实现、工具条自动隐藏时菜单仍开、Esc 在可编辑控件也隐藏工具条）
- Task 12: fix round 1/5 派发中（估算全文高度公式 + destroy 前 flush + 6 项 Minor）
- Task 12: Ruling: 分块保存侧用「按字节比例估算全高」而非延迟保存（代价若错：估算偏差导致恢复位置略有偏差，可接受）
- 计划文档缺陷：Task 12 测试代码块围栏未闭合导致 task-brief 解析错位 → 已修并提交 docs 提交
- Task 12: fix round 1/5 (2 Important + 8 Minor addressed, 0 open — estimateTotalHeight 估算比例、destroy 前 flush、防抖 saver、aria、菜单焦点/隐藏逻辑；commits 6ae42ab..496e9f4)
- Task 12: complete (commits 9dc53ae..496e9f4, review clean after 1 fix round)
- Task 12: minor (deferred): destroy 顺序（clearChunked 先于 stopPositionTracker，仅测试/多实例 teardown 路径）；进度条视觉比例仍按已渲染高度（与保存 ratio 口径分裂）；菜单键盘打开、toast 位置（spec 要右下角）、Ctrl+O 文案、空白页最近面板不自动聚焦、closeRecentMenu 不归还焦点、设置防抖无 pagehide flush
- 计划文档修复：Task 12 围栏未闭合（f49cd7a）+ Task 13 重复段落去重（0d60305）；现 17 任务、围栏平衡、各 brief 正常

## Task 13
- Task 13: complete (commits 0d60305..c8654cf, review clean — Approved，0 Critical/0 Important；宿主 163、前端 344)
- Task 13: minor (deferred): Global\ mutex 被拒时未 try/catch（跨用户会话可能启动崩溃）；长路径 `\?\` 与 NoteResolver PlainPath 冲突致深路径 wikilink 解析失败（无 longPathAware manifest）；握手 500ms 失败静默丢文档；第二实例未 NormalizePath；管道无读超时/无客户端校验；空串激活不还原最小化；换行测试空转；IPC 测试同进程未注明；拖放/对话框零运行证据（T17 手测）；OpenTargetResolver 绝对路径分支注释与实际语义相反；RecoverExisting 大小写歧义；显式目标路径不跳 junction；PlainPath 重复实现；同步 WaitForConnection 字面偏差；UI 线程同步扫目录；MainWindow 722 行宜拆
- Task 13: carry-forward：T17 手测清单需含拖放（.md/文件夹/.png）、Ctrl+O、Ctrl+Shift+O、双开单实例；T14 需复用 `_browseRoot`/pickFolder 并去掉 T13 占位 toast

## Task 14
- Task 14: implemented (commit 8f16c09) — 宿主 175、前端 356；DirectoryLister/tree.js/dirListing{root}/拖入文件夹
- Review 1: [FAIL] 1 Important —— 长路径 `\?\` 前缀不一致导致「短根+深文件」误判根外 → 丢树模式/高亮；8 Minor（pickFolder 先赋值后列目录、迟到子列表不校验 root、失败需折叠重试、晚到列表强展开、UI 线程全量枚举后截断、reparse 测试静默跳过、main.js 1085 行、DirListing 两参重载）
- Task 14: Ruling: DirectoryLister 枚举保留 `\?\` 前缀（>255 根才稳），只在包含性比较时归一 — 代价若错：深路径枚举失败，T17 手测暴露
- Task 14: fix round 1/5 派发中（长路径归一 + 7 Minor + 抽 browse.js）
- Task 14: fix round 1/5 (1 Important + 8 Minor addressed — normalizeForCompare 长路径归一、browse.js 抽取 main.js 1085→955、成功才提根、迟到子列表丢弃、失败单击重试、枚举即停、[Obsolete] 重载；commits 8f16c09..2121a53)
- Task 14: re-review 派发中
- Task 14: 接受：失败重试以 warn/error toast + 在途请求推断（不改协议）；maxEntries 改为枚举前 N 项（不再全局排序前 N 名，超大目录截断集合变化）；reparse 用例本机无特权显式跳过
- Task 14: re-review clean（9 findings 全部 ADDRESSED，7/7 browse 测试通过；产物同字节）
- Task 14: complete (commits c8654cf..2121a53, review clean after 1 fix round)
- Task 14: minor (deferred): warn/error toast 会折叠所有在途目录节点（可单击恢复）；data-failed 只写不读；normalizeForCompare 前缀大小写敏感（宿主只发大写 UNC，暂不可达）；缺 C:\notes vs C:\notes2 边界与尾分隔符根用例；maxEntries 早停测试无法锁住；xunit 跳过计为通过
- Task 14: carry-forward：T17 手测需含 >255 长路径根目录枚举、不可读目录、拖放/对话框、树视觉

## Task 15
- Task 15: implemented + controller addendum（commit 6dc0374、8edee2f：分块全文导出 renderAll、超时 5s→10s；huge.pdf 8 页→1042 页/1.89MB）
- Review 1: Approved 但 1 Important（Path.GetFullPath 在 try/finally 外 → 状态永久卡死）+ 8 Minor
- Task 15: fix round 1/5 (1 Important + 4 加固 addressed — 路径校验前置、打印 60s 内层超时、--verify-pdf 清旧输出、滚动位置恢复、测试补强；commits 8edee2f..d657bf6；复评 clean)
- Task 15: complete (commits 2121a53..d657bf6, review clean after 1 fix round)
- Task 15: minor (deferred): finally 的退出脚本无超时（WebView 卡死时 _exporting 长挂）；超时后底层打印无取消可能留半成品；懒加载图片打印前可能未解码（T17 视觉清单）；保存对话框在并发保护前；VerifyPdf input==output 会先删输入；75s 余量不含同步 renderAll 与 exit 脚本

## Task 16
- Task 16: implemented (commit 824aa0a) — 宿主 207、前端 379；HKCU install→reg query→uninstall 实测 diff IDENTICAL
- Review 1: [FAIL] 2 Important —— ①回滚不完备（Uninstall 不读 hadOpenWithProgid/hadProgIdKey，无条件删 ProgID 子树；备份 dotMdDefault==ProgId 会留悬空默认）②install.ps1/uninstall.ps1 在 Windows PowerShell 5.1 下因 param 默认值里的 $PSScriptRoot 为空直接失败
- Task 16: Ruling: 备份增加 progIdSnapshot + dotMdDefaultPresent + schemaVersion 校验；损坏/不兼容备份不删不改、exit 1；install/uninstall 加跨进程命名 Mutex — 代价若错：回滚复杂化但更安全
- Task 16: fix round 1/5 派发中（2 Important + 5 Minor：AppPaths 不建目录、dotnet 宿主注册错误 exe、DefaultIcon 引号、FakeRegistry/Win32 只读测试、卸载三种文案）
- Task 16: fix round 1/5 (2 Important + 5 Minor addressed — progIdSnapshot/dotMdDefaultPresent/schema 校验/损坏保护/命名 Mutex、PS5.1+UTF8 BOM、apphost 守卫、DefaultIcon 引号、FakeRegistry/Win32 测试、三态文案；commits 824aa0a..7b95f86)
- Task 16: complete (commits d657bf6..7b95f86, review clean after 1 fix round)
- Task 16: minor (deferred): hadProgIdKey=true 恢复后残留空容器键（无运行时影响）；快照 supported=false 项无法回写、REG_EXPAND_SZ 写回变 REG_SZ（概率≈0）；Global→Local Mutex 退化在混合提权场景失效；旧备份无 snapshot 时 CLI 文案略乐观；被篡改备份可在同用户权限内写任意 HKCU 值
- M4 系统能力完成（T13–T16）；剩余 T17（验收/性能/README/图标）+ 最终全分支评审

## Task 17
- Task 17 早期实测：宿主+WebView2 直接子进程 WorkingSet 峰值 ~302MB（大文档）、私有工作集合计 ~153–179MB——与 spec §2.3/§10 的「总内存 ≤150MB」冲突（WebView2 155 常驻 ~150MB 基线，产品侧不可压）
- Task 17: Ruling: 内存验收改为「宿主进程私有内存峰值 ≤150MB」；WebView2 进程组 WorkingSet 作为信息项单列、不计入总判定；同步修正 spec §2.3 第 2 条与 §10 内存行（注明设计阶段未计入 WebView2 常驻成本），plan 不改；README 已知限制写明 — 代价若错：若正确口径应为整树内存，则该验收项实际未达标，需在最终评审中重新裁定

## Final review（4 领域并行，全量 diff 2.1MB 单评审不可行，已记偏差理由）
- 测试质量评审完成：**With fixes**（1 Critical + 8 Important）
  - Critical：唯一 reparse 限制用例在本机「无特权跳过 + Assert.True(true)」→ 绿但零证据
  - Important：①spec §5.11 错误条/渲染异常路径**未实现且无测试**（renderLoad 未 try/catch、无 error bar、无 renderDone 兜底）②spec §9.1 快照/首块渲染耗时/矩阵缺口（Setext/br/img align/math/mermaid/定义列表）③>300 TOC 虚拟滚动未实现且测试锁反向行为 ④IPC 换行测试空转 ⑤chunk 两处 if(anchor)/增长断言可空转 ⑥Store 原子写失败路径未测 ⑦sanitize 变体（大小写/实体/空白/协议相对/svg+xml）未测 ⑧verify.ps1 自身反假通过逻辑无自测
  - must-fix-before-merge 5 条：reparse 测试实效、§5.11 渲染异常/错误条（实现+测试）、三处空转断言、Store 原子写失败、sanitize 变体
  - defer-ok：快照/首块计时/矩阵补行、>300 TOC 虚拟滚动裁决、verify 自测、FakeRegistry 保真、测试卫生
- 宿主评审完成：**With fixes**（2 Critical + 4 Important + 12 Minor）
  - C1：内容可达 openFile 接受任意绝对/UNC 路径 → 本地文件读取 + SMB/NTLM 泄漏（wikilink/data-target 可注入）
  - C2：缺 NavigationStarting 守卫与 e.Source 校验；enhance 的 `a[href^="http"]` 大小写敏感 → `<a href="HTTPS://evil">` 原地导航，远程页继承 chrome.webview 通道
  - I1 窗口几何未持久化（死数据）；I2 单实例转交不激活/还原最小化；I3 WebView2 缺失空白窗口无提示；I4 无全局异常兜底 + Global\ mutex 跨用户崩溃
  - 其余 Minor：编码异常/错误条缺失、debug.log 无滚动、savePosition key 未校验、OpenWithProgid 原值未恢复、UserChoice 未读、openDefaultApps 未分派、verify-pdf input==output 删输入、PDF 半成品/toast 路径/exit 脚本无超时、IPC 读超时/重试、BuildPageHtml 只转义 </script、>20MB 无上限、MainWindow 961 行
- 修复波 A（安全）已派发：C1 协议拆分（openFile 仅相对 + openRecent/openTreeFile 校验）+ NoteResolver reparse、C2 NavigationStarting/e.Source/ContextMenu/enhance 大小写、M3-M11 安全相邻 Minor
- 待：前端评审、基础设施评审 → 波 B（功能缺口 I1-I4 + §5.11 错误条/编码提示 + M2 日志滚动）→ 波 C（测试/验收加固）
- 基础设施评审完成：**With fixes**（2 Critical + 9 Important）
  - C1：install/uninstall 忽略 Windows `UserChoice`（真实默认），卸载后 .md 可能指向已删 ProgID；Classes 默认与 UserChoice 分歧时状态误报；README/spec「完整恢复原状」不成立
  - C2：12/12 PASS 不等于 spec §2.3 六条验收：缺端到端秒表（进程启动→首屏）、16ms 帧预算测量、手测清单未执行、语法矩阵无 traceability
  - I1 分发包缺 install/uninstall/README（build 未拷入 out）；I2 verify 非隔离（写用户 %APPDATA% recent/debug、共用 WebView2 profile，ASCII 理由错误）；I3 内存采样间隔未设门槛；I4 双开未校验第 2 进程 ExitCode；I5 skip 计为通过；I6 README/spec 内存数字与最终报告不符、整树指标计算错误；I7 5 万行曾 180s 挂起未记录；I8 清理可因 PID 复用杀错进程树；I9 spec §8 与实现不符（-SelfContained/136MB/FileDescription/打包）
- 修复波划分：A=安全（进行中）；B=功能缺口（I1-I4 宿主 + §5.11 错误条/编码 + M2 日志 + C1 关联收尾 + I2 数据目录隔离）；C=测试加固（测试评审 must-fix）；D=验收/打包/文档（I1/I3-I9、C2 端到端+帧预算+手测记录+traceability、spec §8）
- 前端评审完成：**With fixes**（0 Critical + 5 Important）
  - I1 §5.11 渲染异常路径未实现：render/onMessage/boot 无 try/catch、chunk 逐块无兜底、无错误条、失败不发 renderDone
  - I2 分块结构保护窄于 markdown-it 语法：无前导 `|` 的表格、引用/缩进内围栏、HTML 块未保护 → >64KB 段可能劈开表格/围栏
  - I3 PDF 导出可能漏掉 lazy 图片（enhance 加 loading=lazy，print 前未等待解码/字体）
  - I4 外链标记大小写敏感（Wave A 已覆盖）
  - I5 sanitize 在 `DOMPurify.isSupported=false` 时 fail-open（应返回空串）
  - Minor：工具栏键盘不可达/焦点丢失、splitBracketed O(n²) DoS、空白启动不应用持久设置、分块 TOC 空 slug 死链、huge 无持久横幅、空白页无「打开文件」按钮、TOC>300 未虚拟化、进度条与保存 ratio 口径分裂、details 不刷新 tops、teardown 订单等
- 修复波规划最终：A 安全（进行中）→ B1 宿主功能缺口（I1-I4 + §5.11 宿主侧 + M2 日志 + C1 关联 UserChoice + 数据目录隔离）→ B2 前端功能/结构（§5.11 错误条/兜底、分块结构保护、PDF 图片等待、sanitize fail-open、huge 横幅、TOC slug、O(n²) 上限）+ 测试加固 → C 验收/打包/文档（verify I3-I9、C2 端到端+帧预算+手测记录+traceability、打包、spec §8）→ 最终 scoped 复评

## 修复波 C（测试加固 / 验收 / 打包 / 文档）
- Wave C: 完成（commit feccf1a；基线 47669b2）。测试：reparse 真实 junction、IPC 换行真实管道、chunk 增长断言、Store 原子写失败+tmp 清理、sanitize 混淆变体/isSafeUrl 直测、矩阵补行+256KB 渲染计时、TOC 350 全量渲染锁定、测试卫生（afterEach destroy/useRealTimers）。
- Wave C: 验收脚本 16 项（第 0 步 `-SelfTest` 21 例）；I2 数据隔离 `JJ_DATA_DIR=<temp>\appdata` + 用户 recent.json 前后哈希；I3 采样最大间隔 ≤250ms；I4 第 2 进程 ExitCode=0；I5 skipped>0 默认 FAIL；I6 整树指标不适用标「不适用」；I7 60s 超时+干净重试 1 次+debug.log 摘要；I8 PID/StartTime/ImagePath 快照校验；I9 分发包完整性；端到端首屏 WARN 口径（本轮 1125–1202ms）。
- Wave C: 实测（PowerShell 7.6.6 / Win10.0.19045 / WebView2 155.0.4283.60）：宿主私有 164.1–175.8MB（20–21 样本/最大间隔 64–66ms）、WebView2 组 230.1–325.7MB、整树 343.0–476.7MB、full-syntax elapsedMs 109–112ms/toc 38、huge 171–177ms/toc 500、PDF 1977619B/1042 页；VERIFY OK（15 PASS + 1 WARN）。
- Descope: TOC >300 虚拟滚动不实现——成本/收益不成立；350 项全量渲染实测 <500ms（`shell-ui.test.js` 锁定为有意行为）。后续建议：仅当真实文档普遍 >1000 标题且用户反馈掉帧时再评估窗口化。
- Descope: 16ms 滚动帧预算不自动测量——jsdom 无真实布局/合成器，Chromium 合成器帧统计无稳定 CLI 接口；改手测（滚轮/键盘连续滚动 5 万行，可选 DevTools Performance），不得声称已自动验证。后续建议：引入 Playwright/WebView2 CDP trace 后作为独立立项。
- Descope: 5 篇 README 快照测试——快照对清洗/高亮版本敏感且审阅价值低；改用结构断言（矩阵逐行 + 集成用例）覆盖。后续建议：确需视觉回归时用 Playwright 截图对比。
- 手测项（拖放/对话框/主题/字体/文件树/关联/长路径/首屏视觉/PDF 视觉/帧预算）本轮全部未执行，逐条记录在 `docs/verify-record.md`；执行方法见 `docs/verify-checklist.md`。

## Fix waves（最终评审之后）
- 波 A 安全（commit f8207f4）：C1 openFile 仅相对 + openRecent/openTreeFile 来源校验 + NoteResolver reparse；C2 NavigationStarting 拦截（实测 e.Source=about:blank）+ 关闭右键菜单 + enhance 大小写；M3-M11 相邻；host 313 tests
- 波 B 产品（47669b2）：I1 窗口几何+DIP 夹紧实测、I2 单实例激活实测、I3 WebView2 解释页、I4 全局异常+mutex 退化、§5.11 错误条/编码提示、notice 消息、M2 日志滚动、UserChoice 生效默认、JJ_DATA_DIR 隔离实测、分块结构保护、PDF 懒图等待、sanitize fail-open、huge 横幅、空白页按钮、TOC 空 slug、O(n²) 上限、工具栏键盘；host 370 / web 416
- 波 C 测试/验收（feccf1a）：reparse 真执行、IPC 换行、Store 原子写失败、sanitize 变体、矩阵补行、首块计时、-SelfTest 21/21、verify 16 项（端到端首屏新增 WARN）、隔离接入、双开 ExitCode、skip 严格、内存采样门槛、打包四件、traceability/verify-record、spec §8/§2.3/§10 修正；host 371 / web 447 / 0 skipped
- UI 波（dca7146 + c01e113）：原创鲸鱼女仆娘 mascot（SVG+ico+PNG，可复现）、reader/whale 双风格可切换 + 持久化、打印链接/装饰修复、对比度 AA、CSS 文本断言 16 例；host 376 / web 474；VERIFY OK 16 项（1 既有 WARN）
- 最终 scoped 复评已派发（host+acceptance / web+tests+UI 两份）

## Final re-reviews & waves D/E
- 最终 scoped 复评（host+acceptance / web+tests+UI）：清单 findings 功能上全部 ADDRESSED
  - 新 Important ①WebView2 UDF 默认被挪到漫游 %APPDATA%（波 D 修复：默认回 LocalAppData，JJ_DATA_DIR 仅测试）
  - 新 Important ②「打开文件…」按钮 Enter 误开最近第一条（波 E 修复）
  - 新 Minor：打印未隐藏 #notice-stack、通知条遮挡、表格分隔行正则过严、导出后 img.loading 未还原、settings 无 pagehide flush、details 展开不刷新 tops（波 E 一并修）
- 波 D（013cbe1）：UDF 本地化、M10 只转义 </script 与 <!--、文档数字/A5/dirListing root/导航措辞/快照 descope、verify 超时读取 5s/清理/恢复环境/SelfTest 锁 21、NoteResolver 文件 reparse；host 382 / web 474；VERIFY OK 16 项（WARN 端到端 1150ms），关键数字：elapsedMs 121/190、宿主私有 162.8MB、artifact 472869B
- 波 E（进行中）：recent Enter 修复、打印隐藏 #notice-stack、通知条不遮挡、表格分隔行正则、恢复 img.loading、settings pagehide flush、details toggle 刷新、spec §9.1 措辞
- 波 E（0af4231，完成）：recent Enter 修复、打印隐藏 #notice-stack、通知条改为内容列首行不遮挡、表格分隔行正则对齐 markdown-it、导出后恢复 img.loading、settings pagehide flush、details toggle 刷新 TOC、spec §9.1 措辞；host 382 / web 488；VERIFY OK 16 项（WARN 端到端 1029ms）
- 最终微复核（c01e113..0af4231）：功能侧零 Critical/Important；唯一残留为文档数字，已由 5e05e83 同步
- 收尾：本地合并 feat/jingjing-reader → master（merge commit 054f379），归档台账与报告（6f9ec4a）；分支与 worktree 已删除，工作区干净
- 合并结果验证：同一提交在干净导出副本中 host 382/382 通过；主仓库内 `dotnet test` 因本会话沙箱无法打开父进程句柄（Win32 5）失败，属环境限制
- 合并后修复（运行位置问题）：用户从 `out\` 直接运行时报 WebView2 `0x800700AA`（资源被占用）；根因是工作区目录的受限安全标签/位置，不是代码逻辑（同一 exe 复制到普通目录可正常渲染）。修复：`install.ps1` 改为先复制到 `%LOCALAPPDATA%\Programs\JingjingReader` 再注册（`-Portable` 保留就地模式），`uninstall.ps1` 默认删除安装目录（`-KeepFiles` 保留）；WebView2 失败对话框新增「重试」「清除缓存并重试」（重置缓存目录，不动文档/设置）；README/spec/清单同步；新增 `WebView2Recovery` 纯函数与 6 条单测（host 388）。
- 修复后验收（@54b9fbb，D:\jj-final-verify 克隆）：VERIFY OK 16 项（15 PASS + 1 WARN 端到端 1117ms）；host 388 / web 488 / 0 skipped；宿主私有内存 167.5MB；PDF 1084 页；分发包完整；用户数据未被改写。报告见 docs/sdd/verify-report-install-fix.md。
