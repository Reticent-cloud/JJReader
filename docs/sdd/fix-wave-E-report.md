# 修复波 E 报告（最后一次复评残余，web 前端）

- 日期：2026-10-18
- 分支：`feat/jingjing-reader`
- 基线：`013cbe1`（本轮开始前 HEAD）
- 本轮提交：`0af4231`（单条中文 commit，未改写历史；`e0f657e` 为删除无用内部函数 `currentIndex` 前的 amend 前身，内容等价，仅少一处死代码）
- 结论：**完成**。web **21 files / 488 tests** 全绿（0 skip，较上轮 474 增加 14 个用例）；host **382** tests 全绿；`scripts/build.ps1` **BUILD OK**；`scripts/verify.ps1` **VERIFY OK**（16 项：**15 PASS + 1 既有 WARN + 0 FAIL**，WARN 仍是端到端首屏 1029 ms）；`-SelfTest` **21/21**。
- 范围：只改 `web/src` 的 CSS/JS、`tests/web` 与文档；宿主代码/协议/verify 门槛/渲染管线语义未改。`src/Host/Resources/md-engine.js` 是 `build.ps1` 重新生成的受跟踪前端产物（与 `web/dist` SHA256 一致），随提交更新。

## 1. Important：「打开文件…」按钮 Enter 误开最近第一条

**改法**（`web/src/shell/recent.js:289-301`）
- Enter 分支不再无条件 `preventDefault()` + `open(buttons[currentIndex()])`，改为只在
  `event.target.closest('[data-path]')` 命中「最近项」时拦截并打开该项；否则直接 `return` 放行默认行为
  （焦点在「打开文件…」按钮时，浏览器把 Enter 转成按钮 click → `onPickFile` → `pickFile`）。
- 面板没有 click 委托与按钮冲突，无需 `stopPropagation`；按钮 click 仍只走 `onPickFile`。

**测试**
- `tests/web/shell-ux.test.js` 新增「「打开文件…」按钮上的 Enter 不被面板拦截，最近项上的 Enter 才打开」：
  断言按钮 Enter 的 `defaultPrevented === false`、`onOpen`/`onPickFile` 都没有被键盘路径触发；随后 `pick.click()`
  只触发 `onPickFile`；最近项上的 Enter 触发 `onOpen`。
- 新增「无最近项时面板不拦截 Enter（「打开文件…」按钮仍可正常激活）」。
- `tests/web/shell-errors.test.js` 新增 shell 级用例（真正发消息）：焦点在按钮时 Enter 后 `posted` 无 `openRecent`
  （放行默认行为后 click → 1 条 `pickFile`）；焦点在最近项上 Enter → 最后一条 `openRecent {path:'C:\\a.md'}`；
  另有无最近项时按钮 Enter → `pickFile` 的用例。
- 既有「面板上直接派发 keydown」用例按真实浏览器语义更新：Enter 派发到当前焦点项（`event.target` 是按钮），
  ArrowDown 仍直接派发在面板上（保留「不依赖冒泡」的原意）。
- RED 证据：改实现前新用例失败（按钮 Enter 触发 `openRecent` 且 `defaultPrevented === true`）；改后通过。

## 2. 打印隐藏 `#notice-stack`

**改法**（`web/src/styles/print.css:25-39`）
- chrome 隐藏列表加入 `body.print-mode #notice-stack { display: none !important; }`（与工具条/浮层同一规则组）。

**测试**（`tests/web/ui-css.test.js`）
- 新增「通知条（#notice-stack）不进入纸面」：对 `print.css` 文本断言 `body.print-mode #notice-stack` 规则含
  `display: none !important`。

## 3. Minor UX：通知条不遮挡正文/TOC

**改法**（`web/src/styles/layout.css`、`web/src/shell/main.js`）
- `#app` 网格由单行改为 `grid-template-rows: auto minmax(0, 1fr)`；`#notice-stack` 作为内容列第一行网格项
  （`grid-column: 2; grid-row: 1`），有通知时**占据高度把正文整体下移**，不再 `position: fixed` 覆盖。
- `#content` 固定到第二行（`grid-row: 2`）；`#toc` 跨两行（`grid-row: 1 / -1`），通知条只在内容列挤占空间，
  TOC 顶部不被遮挡。
- 「打开文件」工具栏仍是 fixed 悬浮层；通知条顶部留白 `calc(var(--toolbar-height) + 8px)`，工具条显隐都不会压住它。
- `#notice-stack[hidden] { display: none; }` 压过 `display: flex`；shell 新增 `syncNoticeStack()`，在
  show/hide 错误条与大文件横幅时同步 `hidden`，两条都隐藏时整行高度为 0。容器维持 `pointer-events: none` +
  子元素 `pointer-events: auto`，不拦截滚轮/框选；`role=alert` 与暗色变量适配不变。

**测试**
- `tests/web/shell-errors.test.js` 新增「通知条随内容显隐」：初始 `hidden`；`notice` 消息后 `#notice-stack.hidden === false`
  （`#error-bar` 仍 `role=alert`）；关闭后 `hidden === true`；大文件横幅出现时同样可见、关闭后隐藏。
- `tests/web/ui-css.test.js` 新增三项布局文本断言：`#notice-stack` 无 `position: fixed` 且含 `grid-column: 2` /
  `grid-row: 1` / `pointer-events: none`；`#content` 在 `grid-row: 2`、`#toc` 为 `grid-row: 1 / -1`；
  `#notice-stack[hidden]` 为 `display: none`。

## 4. 表格分隔行正则对齐 markdown-it

**改法**（`web/src/chunk.js:46-67, 234`）
- 删除要求 ≥3 横线的 `TABLE_SEPARATOR_RE`，新增 `TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/` 与
  `isTableSeparatorLine()`：按 `|` 拆单元格（允许首尾可选 `|`）后逐格校验，与 markdown-it table rule 同口径；
  单独一行 `---` 因行内无 `|` 仍不是表格分隔行（不误伤 setext/分隔线）。
- 结构分析里改用 `isTableSeparatorLine(structural)`。

**测试**（`tests/web/chunk-structure.test.js`）
- 新增「markdown-it 口径的单横线分隔行 `- | -` 同样保护 100KB 表格不被切」：`maxBlockBytes: 512` 下断言
  `blocks.length === 1` 且 `blocks.join('') === 原文`。
- 新增「带对齐单横线分隔行（`:-- | --:`）也整块保留」。
- RED 证据：改实现前两个用例都被切成多块；改后通过。

## 5. 导出后恢复 `img.loading`

**改法**（`web/src/print.js`）
- 模块级 `activeImageRestore`；`waitForPrintAssets` 对每张 `loading !== 'eager'` 的图片记录原值
  （`loading` 属性有无/值 + IDL `image.loading`）后再改 `eager`，并登记恢复函数。
- `enterPrintMode` 的 `exit()` 末尾调用 `restorePrintImages()`：有属性写回原值、原本无属性则移除属性；
  不反射属性的环境同时还原/删除 IDL 值；恢复失败不影响主题/class/滚动位置清理。幂等，重复退出安全。

**测试**（`tests/web/print.test.js`）
- 新增「退出打印模式恢复被临时改为 eager 的图片 loading」：真实 img（`loading="lazy"` 与无属性各一张），
  `enterPrintModeForPdf()` 后两者都 eager；`exitPrintModeForPdf()` 后 lazy 的 `getAttribute('loading') === 'lazy'`、
  无属性的 `hasAttribute('loading') === false`，且两者的 `image.loading` 都不再是 `eager`。
- RED 证据：改实现前退出后两张图仍是 `eager`，用例失败；改后通过。

## 6. 设置防抖 pagehide / 页面隐藏 flush

**改法**（`web/src/shell/settings-saver.js`、`web/src/shell/main.js`）
- `createSettingsSaver` 绑定 `pagehide` 与 `visibilitychange(hidden)` 立即 `flush()`（与 `createPositionTracker` 同口径），
  返回新增 `destroy()`：先补发 pending，再解绑页面监听（`flush`/`save` 在 destroy 后为空操作，重复 destroy 幂等）。
- `main.js` 的 `destroy()` 改调 `settingsSaver.destroy()`（原先只 `flush`，全局监听会泄漏到下一次装配）。

**测试**（`tests/web/shell-ux.test.js`）
- 新增「pagehide / 页面隐藏时立即 flush 防抖中的设置 patch」：滑杆 input 后 `pagehide` → 立即一条 `saveSettings{patch}`；
  `visibilitychange + hidden` → 再落盘一次；`visible` 不落盘。用 `stubVisibility` 切换 `document.visibilityState`。
- RED 证据：改实现前 pagehide 用例没有发出 `saveSettings`；改后通过。

## 7. `details` 展开刷新标题 tops

**改法**（`web/src/shell/main.js:1191-1201, 1229`）
- `#content` 新增捕获阶段 `toggle` 监听（details 的 toggle 不冒泡）；target 为 `DETAILS` 时调用
  `scheduleRefreshHeadingTops()`（rAF 合并）；`destroy()` 解绑。

**测试**（`tests/web/shell-ui.test.js`）
- 新增「details 展开/折叠（toggle 不冒泡）后也刷新标题位置」：先滚到乙高亮，在 `h2` 前插入 details 并把 h2 的
  offsetTop 桩到 1200，向 details 派发不冒泡的 `toggle`，等一帧后高亮回到甲（旧快照 400 会仍高亮乙）。
- RED 证据：改实现前 toggle 后无刷新，高亮仍为乙；改后通过。

## 8. 文档小同步

- `docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md §9.1`：
  - 「5 篇 README 快照」条目明确标注 **已 descope**（结构断言替代），并注明 descope 记录在 SDD ledger `progress.md` 与
    `docs/acceptance-traceability.md`；
  - 「性能冒烟」改为：切块/预扫描 < 300 ms 仍保留；首屏当前以「前 256 KB 一次性 render < 1000 ms」作 jsdom 冒烟护栏，
    真实首屏预算由 `verify.ps1` 的端到端项（`--verify-render` 的 `elapsedMs` 与 `Process.Start → READY`）覆盖，
    不在单测里冒充预算门禁。
- `docs/verify-checklist.md §18` 新增两条手测项：「打印预览/导出 PDF 时顶部通知条不出现」；「空白启动页 Tab 到
  「打开文件…」按钮后按 Enter 弹系统对话框（不误开最近第一条），焦点在最近项上 Enter 才打开该项」。

## 验证证据（本轮最终一次：提交 `0af4231` 后、工作树 clean 时复跑）

| 项 | 结果 |
|---|---|
| 前端单测（`cd web && npm test`） | **21 files / 488 tests passed，0 failed，0 skipped** |
| 宿主单测（`dotnet test`） | **382 passed / 0 failed / 0 skipped** |
| 构建（`pwsh -File scripts/build.ps1`） | **BUILD OK**，`out\JingjingReader.exe`；`md-engine.js` 475324 B → 已同步 `src/Host/Resources/` |
| 验收（`pwsh -File scripts/verify.ps1`） | **VERIFY OK**，16 项：15 PASS + 1 既有 WARN（端到端首屏 1029 ms）+ 0 FAIL；报告 `out/verify-report.md` 记录 `feat/jingjing-reader @ 0af4231（工作树 干净）` |
| `-SelfTest` | **21/21** |
| 关键实测 | full-syntax `elapsedMs` 113 ms / tocCount 38；5 万行 `elapsedMs` 185 ms / tocCount 500；宿主私有内存峰值 174.3 MB；PDF hello 18787 B、5 万行 2314459 B / 1084 页；dist 与 Resources 均 475324 B、SHA256 一致 |
| 工作树 | clean（报告与 `.superpowers/` 按惯例 gitignore，不进入提交） |

## Concerns / 未自动化项

- 通知条的「挤占而非覆盖」是 CSS 网格布局行为，jsdom 无真实布局：自动化只锁定选择器/声明与 JS 显隐同步，
  真实视觉效果（含 TOC 顶不被遮挡、错误条换行、暗色对比度）仍需按 `docs/verify-checklist.md §18` 新增手测项确认。
- `image.loading` 的恢复在浏览器里靠属性反射，jsdom 里靠 IDL 还原（测试同时断言两者）；若未来引入不反射
  `loading` 的第三方 img 实现，恢复逻辑仍会移除属性兜底。
- 通知条可见时正文整体下移导致滚动视口变短，但 `#content` 内部 padding/标题 offsetTop 不变，故不需要额外刷新
  标题快照（这也是刻意保持 padding 不变的原因）。

## 文档同步（最终复评：数字以最终验收 @0af4231 为准）

- 提交：`5e05e83`（`docs: 同步最终验收数字（@0af4231）并修正过期指针`），仅改文档，未跑 build/verify（按任务要求不重新生成报告）。
- 权威来源：`out/verify-report.md`（`feat/jingjing-reader @ 0af4231（工作树 干净）`，2026-10-18 05:14:04 +08:00，16 项 = 15 PASS + 1 WARN）。所有改写数字逐项抄自该报告，未虚构；报告中没有的值保留原值并注明来源。
- 统一后的数字：host **382 passed**；web **21 files / 488 tests**；full-syntax `elapsedMs` **113 ms**、tocCount 38；5 万行 `elapsedMs` **185 ms**、tocCount 500、尝试 1 次；端到端首屏 **1029 ms（WARN）**；宿主私有内存峰值 **174.3 MB**（19 样本，最大间隔 64 ms）；WebView2 组 **235.7 MB**（6 个 msedgewebview2，500 ms 采样 1 次）；整树 **349.8 MB**；PDF hello 18787 B、5 万行 2314459 B / 1084 页；产物 `md-engine.js` **475324 B**（`web/dist` 与 `src/Host/Resources` SHA256 一致）。
- 文件与改动点：
  - `README.md`：注意 1（内存 174.3 MB / 19 样本 / 64 ms；WebView2 235.7 MB / 6 进程 / 1 样本；整树 349.8 MB）、注意 2（113 / 185 / 1029 ms WARN）、已知限制「内存主要在 WebView2 内核」与「首屏与帧预算」、验收小节与目录树里的 verify-record 指针；「本轮 16 项」→「每次 16 项」。
  - `docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md`：§2.3 第 1/2/4 条与脚注（进程数 6 个、手测口径）、§9.3 检查项措辞、§9.4 手测口径、§10 表与脚注（端到端 1029 ms、内存 174.3 MB / 19 样本 / 64 ms、WebView2 235.7 MB / 1 次、整树 349.8 MB、进程数 6、产物 475324 B）；`472869 B` → `475324 B`；波 C 复核脚注改标「historical，仅存档」。
  - `docs/acceptance-traceability.md`：头部日期/基线与权威指针（`013cbe1` → `0af4231`）、2.3-1a/1b/2/4a、9.3-2/3/4/7 的数字（382 / 21 files / 488 tests、113 / 1029 / 174.3 MB / 185 ms），人工项口径改「截至最终验收仍未执行」。
  - `docs/verify-record.md`：改为「最终验收口径开篇 + 波 C historical」；最终表 16 行全部取报告值；波 C 的 376/474、1.6 MB、109–112 ms、1125–1202 ms、171–177 ms、164.1–175.8 MB、18791 B、1977619 B/1042 页、435762 B、230.1–325.7 MB、343.0–476.7 MB 全部保留并标 historical。
  - `docs/verify-checklist.md`：记录区脚注「本轮（修复波 C / 界面美化波）…未执行」→「截至最终验收（@0af4231）…未执行」。
- 保留原值并注明来源（最终报告未含）：`out\` 2.8 MB（11 文件）、`out-selfcontained\` 135.8 MB（15 文件）、exe ProductName/FileDescription 与版本 0.1.0.0（均为波 C 实测，verify-record 已标「波 C 实测，未写入最终报告」）。
- 残留检查：`grep` 确认 `162.8 / 321.8 / 475.8 / 121 ms / 190 ms / 1150 / 472869 / 21 个样本 / 采样 2 次 / 5 个进程 / 修复波 D 最终验收` 在这四个文档中已无残留；仅 verify-record 的 historical 一节保留 `474 tests`、`435762 B`、`230.1–325.7 MB`、`343.0–476.7 MB`、`1125–1202 ms` 等历史值并已明确标注；`git diff --check` 干净。
