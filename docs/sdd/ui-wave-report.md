# 界面美化波（UI Wave）报告

日期：2026-10-18
分支：`feat/jingjing-reader`（worktree `D:\dsh-work\MD阅读器\.worktrees\feat\jingjing-reader`）
起点：`feccf1a`（波 C）
提交：`dca7146`（界面美化波）
范围：仅视觉/资产/UI 偏好；不改渲染、协议、分块、打印流程、验收门槛与进程行为。

## 1. 结论

- 已交付两套可切换界面风格：`reader`（阅读器风，默认）与 `whale`（鲸鱼娘主题）。
- 已交付原创「鲸鱼女仆娘」形象：多尺寸 `app.ico`、关于面板 `AboutMascot.png`、前端内联 SVG（`web/src/mascot.js`）。
- `uiStyle` 已进入 `AppSettings` / `settings.json`，`load` 与 `settings` 消息自然带出；前端启动即应用，未知值回退 `reader`。
- 既有测试保持：宿主 376 通过 / 0 跳过（原 371，新增 5 例），前端 458 通过（原 447，新增 11 例）。
- 全量验收：`VERIFY OK`（16 项：15 PASS + 1 既有 WARN「端到端首屏 1162 ms」，无新增 FAIL）。

## 2. 形象设计（原创鲸鱼女仆娘）

> 全部图形由本仓库代码现场绘制：前端是手写 SVG 字符串，宿主图标/PNG 由 `scripts/gen-icon.py` 用 Pillow 的椭圆/圆弧/贝塞尔路径绘制。不包含任何网络同人图、外部 URL、`<image>`、`<use>` 或脚本。

### 2.1 元素

- **鲸鱼身体/圆头**：横向圆润的深蓝鲸鱼头身，腹部为浅蓝白（`#DCE7FF`）+ 两条腹纹。
- **鲸尾**：身体右后方一整片宽叶形尾鳍（中央凹口 + 上下圆钝尾尖），与身体同色系但加深（`#2A44B8`）。
- **女仆头饰**：弧形白色/冰蓝白发带，外缘 6 个荷叶边圆瓣 + 浅蓝描边；右侧小蝴蝶结。
- **发丝**：深蓝后发、两侧发束、波浪刘海与一根呆毛（`#15255E`）。
- **面部**：深色大眼 + 双高光、粉色腮红、微笑嘴线。
- **环境元素**：低透明度气泡（`#9BD8FF`）与浪花线；大插画含浅蓝光晕、虚线圈、星光与底部双浪。

### 2.2 配色

| 用途 | 色值 |
| --- | --- |
| 主蓝（DeepSeek 蓝） | `#4D6BFE` |
| 深蓝（发丝/暗部） | `#15255E` / `#1B2A6B` |
| 鲸尾 | `#2A44B8` |
| 腹部 | `#DCE7FF`（纹理 `#AFC5FF`） |
| 头饰 | `#E2ECFF`（描边 `#96B0E8`；比纯白略冷，保证白底与浅色圆盘上都有轮廓） |
| 蝴蝶结/腮红 | `#FF9EB5` / `#FF7FA8` |
| 气泡/浪花 | `#9BD8FF` / `#8FD3FF` |
| 图标底 | `#4D6BFE` → `#1B2A6B` 竖向渐变 + 顶部 30 Alpha 柔光 |

### 2.3 尺寸适配

- **16 / 32 px**：专用剪影版——偏左的白色圆头 + 5 瓣荷叶边轮廓 + 右侧加宽鲸尾 + 深蓝眼睛；白色对深蓝底对比高，16 px 仍可辨「鲸尾 + 圆头 + 头饰」。
- **48 / 256 px**：细节版——浅色圆盘上绘制彩色吉祥物（头饰、发丝、腮红、气泡、浪花）。
- **AboutMascot.png**：256×256、透明背景，细节版 4× 超采样后 LANCZOS 降采样。
- **前端 SVG**：64×64 工具栏/水印小图；220×220 空状态插画（光晕 + 气泡 + 星光 + 双浪）。

## 3. 两套风格清单

### 3.1 阅读器风（`data-ui-style="reader"`，默认）

参考 Typora/Obsidian 的克制美化，只改样式与少量装饰 DOM：

- 正文：h1 最大 + 短强调线 + 淡下边框；h2 去边框弱化；h3 加粗；段落 1em 间距；行高沿用现有变量。
- 链接：去下划线、hover 才下划线；正文链接 `#3A55E8`（保证白底 ≥ 4.5:1），强调色仍用 `#4D6BFE`。
- 引用块：左侧 3 px 强调色 + 浅底 + 右侧圆角；表格斑马纹 + 表头浅底 + 圆角边框；行内代码浅底圆角；hr 细线；任务清单复选框强调色；`::selection` 淡蓝。
- 代码块：统一顶栏色带（32 px，只承载已有复制按钮；渲染管线没有语言标签 DOM，按硬约束不新增）+ 圆角外框。
- 组件：工具条按钮 hover/active/focus-visible；Aa 面板圆角阴影；TOC 当前项左侧强调条；最近文件卡片 hover；toast 圆角阴影；细窄 WebKit 滚动条。
- 装饰：主题按钮使用小 mascot；空状态 96 px mascot；关于面板 256 PNG mascot；正文区无装饰。

### 3.2 鲸鱼娘（`data-ui-style="whale"`）

- 背景：浅色为浅蓝→白径向/线性渐变；暗色为深蓝→近黑的同结构渐变；`body:not(.print-mode)` 限定，打印保持纯白。
- 装饰层：`#ui-decor` 固定全屏、`pointer-events:none`、`aria-hidden="true"`、`z-index:0`；正文列/侧栏 `z-index:1`，装饰只在正文之下；14 个确定性定位气泡 + 132 px 右下角水印（低透明度）。
- 组件：工具条/侧栏半透明玻璃、按钮与卡片圆角加大、hover 轻微上浮；TOC 卡片化；最近文件卡片化；toast 胶囊圆角；Aa/最近菜单毛玻璃。
- mascot：空状态 220 px 主角；工具栏左侧 28 px；主题按钮 16 px；关于面板 256 PNG。
- 列表符号：仅 `#content > ul` 一级项，用 `mask` + data URI 的鲸尾图标，`::before` 空 content 不进入可访问性文本流；二级列表/有序列表/任务清单不受影响。
- 动效：气泡漂浮、hover 上浮；`prefers-reduced-motion: reduce` 下全部取消（含 reader 的 hover 位移）。

### 3.3 组合与打印

- `reader`/`whale` × `light`/`dark`/`system` 共 2×3 组合；system 的 `prefers-color-scheme` 监听沿用现有 `theme.js`。
- 打印/PDF：`print.css` 末尾追加覆盖——装饰层、水印、工具栏 mascot、空状态 mascot、代码块顶栏伪元素全部 `display:none`；`html[data-ui-style] body.print-mode` 强制纯白；斑马纹/引用底/表头底/卡片阴影在纸面清除。
- 打印模式不修改 `data-ui-style`，退出后风格仍在（有测试）。

## 4. 切换入口与持久化

- 工具条新增 `#ui-style-toggle`（mascot 图标 + 「主题」文案）；点击 `reader ↔ whale`，`title`/`aria-pressed` 随状态更新。
- Aa 面板顶部新增「界面风格」下拉（`data-setting="uiStyle"`，阅读器风/鲸鱼娘）；与工具条共用 `updateSettings` 单一入口，双向同步。
- 切换即时应用（`applyUiStyle` 写 `html[data-ui-style]`）并 `post('saveSettings', {patch:{uiStyle}})`，只发变化字段；`settingsPatch` 比较后不会夹带其它字段。
- 宿主 `AppSettings` 末尾新增 `string UiStyle = "reader"`；`SettingsPatch` 合并字符串字段；`load`/`settings` 用现有 `AppSettings` 序列化自然带出。
- 前端 `normalizeUiStyle` 只接受 `whale`，其它（含旧配置/手改/未知）回退 `reader`；`applySettings` 任意路径都会同步 `data-ui-style`，空白启动与 load 后一致。
- `src/Host/Resources/index.html` 的 `<html>` 预置 `data-ui-style="reader"`，首屏无风格闪烁。

## 5. 图标生成说明

`scripts/gen-icon.py`（Pillow）重写要点：

- 8×（16/32/48）与 4×（256）超采样后 LANCZOS 降采样；16/32 走剪影函数，48/256 走细节函数，**每个尺寸独立绘制**而不是从 256 缩。
- 手写 ICO 容器（ICONDIR + 4 个 PNG 帧），显式 16/32/48/256；Pillow 读取验证 `ico.sizes()` 为四尺寸。
- 输出 `src/Host/app.ico`（约 51 KB）与 `src/Host/AboutMascot.png`（256×256 RGBA，透明，约 38 KB）。
- 固定坐标、无随机数，`python scripts/gen-icon.py` 可重复运行；脚本同时保留 `--output` 并提供 `--mascot-output`。
- `JingjingReader.csproj` 用 `<Resource Include="AboutMascot.png" />` 打包；`AboutWindow.xaml` 以 96×96 显示在标题左侧，并加一行「界面风格」说明。
- 可重复性验证：连续两次运行输出相同字节；`.g.resources` 中可查到 `AboutMascot.png`。

## 6. 测试

### 6.1 前端（`tests/web/ui-style.test.js`，新增 11 例）

- `applyUiStyle('reader'|'whale'|未知/undefined/null)` → `html[data-ui-style]` 正确回退。
- `normalizeUiStyle` / `nextUiStyle` / `uiStyleLabel` 两态口径。
- `applySettings` 任意设置路径同步 `data-ui-style`。
- mascot SVG 常量：`viewBox` 正确、无外部 `href/src/url()/script/image/use/foreignObject`，含鲸尾/头饰/气泡色值。
- `bubbleDecor` 数量夹紧 0–24、非数字为 0、样式只含数字。
- shell 装配：`#ui-decor` aria-hidden、14 气泡、水印、空状态 mascot、工具条 mascot、Aa 下拉默认 reader。
- 工具条按钮 reader↔whale、`saveSettings` 只发 `{uiStyle}`、`aria-pressed`/title 同步。
- Aa 下拉切换、工具条→下拉回显。
- `settings` 消息在空白启动应用 uiStyle（含未知值回退）。
- `load` 的 `settings.uiStyle` 在渲染前应用。
- 打印模式不重置 `data-ui-style`，退出后仍在。

### 6.2 宿主

- `StoreTests.Settings_roundtrip_includes_ui_style`：默认 reader、whale 往返、camelCase `"uiStyle": "whale"`、相邻字段不受影响。
- `SettingsPatchTests.Apply_merges_ui_style_and_keeps_it_when_patch_omits_it`：合并 whale、后续 patch 不重置、未知字符串透传（前端负责回退）。
- `SettingsPatchTests` 新增 3 个类型不符 Theory 样本（数字/null/数组被忽略）。
- `ProtocolTests` / `ProtocolNoticeTests`：`load` 的 `settings.uiStyle` 与 `settings` 消息都带出 whale。
- 既有测试未改弱（仅扩展断言）。

### 6.3 结果

| 项 | 结果 |
| --- | --- |
| `dotnet test tests/host/JingjingReader.Tests.csproj` | 376 通过 / 0 失败 / 0 跳过（原 371，+5） |
| `cd web; npm test` | 20 文件 / 458 通过（原 447，+11） |
| 前端产物 | 469294 B（≤ 500 KB），`web/dist` 与 `Resources` SHA256 一致 |

## 7. verify.ps1 结果

命令：`pwsh -NoProfile -File scripts/verify.ps1`（PowerShell 7.6.6）
结果：**VERIFY OK**（16 项：15 PASS + 1 既有 WARN）

关键数据：

- 构建 exit 0；分发包完整性 PASS。
- full-syntax：`elapsedMs=116`、`tocCount=38`、端到端 1162 ms（WARN，既有口径：<1000 PASS / ≤2500 WARN）。
- 5 万行：`elapsedMs=188`、`tocCount=500`；宿主私有内存峰值 170.2 MB（≤200 MB），采样 21 次、最大间隔 65 ms；WebView2 进程组 316.9 MB（信息项）。
- PDF：hello 18807 B（>5 KB）；5 万行 2317537 B（>1 MB）、1084 页（>100）。
- 双开单实例、产物一致性、用户 `recent.json` 未改写均 PASS。

`out/verify-report.md` 已由脚本重写。

## 8. 需手测项（视觉细节）

自动测试只覆盖 DOM/状态，不覆盖像素。请按 `docs/verify-checklist.md` §18（以及 §15 图标/关于面板）执行：

1. 两套风格 × 浅色/深色/跟随系统逐一目视；切换系统主题是否实时、无白闪。
2. 鲸鱼娘装饰层是否遮挡正文/文本选择/点击（框选跨气泡文字）；水印是否压字。
3. 空状态 220 px mascot、工具栏左侧 28 px、主题按钮 16 px、关于面板 96 px 是否清晰无裁切；16 px 任务栏/资源管理器图标是否可辨。
4. 两套风格下 `Ctrl+E` 导出 PDF/打印预览是否纯白、装饰是否全部隐藏、表格/代码是否可读。
5. 鲸尾列表符号是否只出现在一级无序列表；读屏是否不朗读该符号。
6. `prefers-reduced-motion` 下气泡/上浮是否停止。
7. 切换风格后重启，`settings.json` 的 `uiStyle` 是否保持；Aa 下拉与工具条是否同步。

**未提交界面截图的原因**：自动验收不产出视觉基线；截图会随主题/字体/DPI/WebView2 版本变化而过期，且本轮无法在 WPF 宿主里自动驱动真实窗口截图。仓库只保留可复现的代码资产与手测清单；本地可按清单截图存到 `docs/verify/`（可选）。

## 9. 变更文件

- 资产/脚本：`scripts/gen-icon.py`、`src/Host/app.ico`、`src/Host/AboutMascot.png`、`web/src/mascot.js`。
- 前端：`web/src/ui-style.js`、`settings.js`、`index.js`、`shell/main.js`、`shell/toolbar.js`、`shell/recent.js`、`styles/overrides-reader.css`、`styles/overrides-whale.css`、`styles/print.css`、`src/Host/Resources/index.html`、`src/Host/Resources/md-engine.js`。
- 宿主：`Store.cs`、`SettingsPatch.cs`、`AboutWindow.xaml`、`JingjingReader.csproj`。
- 测试：`tests/web/ui-style.test.js`、`tests/host/StoreTests.cs`、`SettingsPatchTests.cs`、`ProtocolTests.cs`、`ProtocolNoticeTests.cs`。
- 文档：`README.md`、spec §5.2/§5.4/§8/§13/§14、`docs/verify-checklist.md`。

## 10. Concerns / 已知取舍

1. **代码块语言标签**：渲染管线里没有语言标签 DOM；按「不改渲染」硬约束只在样式上做了统一顶栏色带 + 既有复制按钮，没有新增标签。
2. **16 px 图标**：采用几何剪影（圆头 + 荷叶边轮廓 + 宽尾 + 眼睛），保证高对比；是否在具体任务栏缩放/高 DPI 下足够可辨仍需人工看一眼。
3. **关于面板 mascot**：已确认 PNG 进入 WPF `.g.resources` 且 XAML 编译通过，但自动验收不打开模态窗口，实际显示需手测。
4. **头饰颜色**：为了在白底与浅色圆盘上都可见，荷叶边使用冰蓝白 `#E2ECFF` + 浅蓝描边，而非纯白；视觉上仍是白色女仆头饰。
5. **无视觉回归**：本波没有引入截图基线，后续改样式仍可能回归；建议后续波次补一个可选截图脚本（非验收门槛）。
6. **既有 WARN**：端到端首屏 1162 ms，属于既有的「1000–2500 ms 记 WARN」口径，本波未改验收门槛，也未新增 FAIL。

## 11. UI 波评审修复（2026-10-18，commit `c01e113`）

范围：只改 CSS / 文档 / 测试；未改渲染、协议、验收门槛与产品逻辑。

### 11.1 逐项改法

1. **打印/PDF 链接样式回归（Important）**
   - `overrides-reader.css` / `overrides-whale.css` 的 `#content a` 与 `a:hover` 规则整体包进 `@media screen`，屏幕样式不再参与纸面级联。
   - `print.css` 新增 `body.print-mode #content a { color: inherit; text-decoration: underline }`，并追加同规则的高特异性选择器 `html[data-ui-style] body.print-mode #content a` 作为双保险（即使媒体类型判断异常也压过界面风格的 1,1,2 规则）。
2. **浅色 active 文本对比度（Important）**
   - `overrides-reader.css`：工具条 `.tool.active` 与 TOC `a.active` 的文本色由 `--ui-accent` 改为 `--ui-accent-strong`（#3A55E8，浅色 active 底 ≈5.1:1）。
   - `overrides-whale.css`：工具条 `.tool.active`、TOC `a:hover`、TOC `a.active` 三处文本同样改为 `--ui-accent-strong`；`--ui-accent` 继续只用于左侧条、边框、焦点轮廓、图标与 `accent-color`。
3. **打印残留鲸尾/ h1 装饰（Minor）**
   - `print.css`：`body.print-mode #content ul { list-style: revert }`，非任务清单 `li` 恢复列表符号，`ul.contains-task-list` 保持 `none`；`#content ul > li::before` 以 `content:none/display:none` 清除鲸尾伪元素。
   - `body.print-mode #content h1` 增加 `border-bottom: 0 !important; background: none !important`，两套风格的 h1 下边框/强调线不进入纸面。
4. **front matter 表被通用表格规则重绘（Minor）**
   - 两套 `overrides-*.css` 末尾新增 `#content .frontmatter table/th/td`（含斑马纹 selector）reset：`border: 0`、`background: transparent`、`box-shadow: none`、`border-collapse: collapse`、`border-radius: 0`；保留 `layout.css` 的卡片内两列键值排版，消除双边框。
   - `print.css` 同步为 front matter 表格清除边框/底色，避免 PDF 中卡片内再出现表格框。
5. **手写 HTML 列表文案（Minor）**
   - `docs/verify-checklist.md` §18 更正为「一级无序列表显示鲸尾符号（含手写 HTML 的 `<ul>` 也会显示）」，不再声称手写 HTML 列表不受影响；实现不改为标记 DOM（保持不改渲染）。
6. **文档/记录一致性（Minor）**
   - 按钮实际渲染是鲸鱼 SVG + 「主题」：README（功能特性、工具条顺序、界面风格、快捷键表）、关于面板 XAML、spec §5.2、checklist 与测试描述统一为「主题」（鲸鱼图标），删除所有「🐳 主题」写法。
   - README 约束改为「只改样式与装饰，不改变渲染与交互逻辑，也不改布局结构、分块、协议与验收口径」。
   - README 空状态 mascot 尺寸按实际：阅读器风 96 px、鲸鱼娘 220 px；工具栏左侧 28 px、关于面板 96 px。
   - `docs/verify-record.md` 单测两行更新为修复后全量：宿主 376 / 前端 21 files / 474 tests，并注明波 C 当时为 371 / 19 files / 447。
7. **令牌与常量去重（Minor）**
   - 删除 `--whale-ink` 两个定义（全仓库未使用）。
   - `UI_STYLE_OPTIONS` 由 `web/src/ui-style.js` 单一导出（基于 `UI_STYLES` + 标签表），`web/src/shell/toolbar.js` 改为 import，删除本地重复数组。
8. **CSS 文本级断言（Minor）**
   - 新增 `tests/web/ui-css.test.js`（16 例，`fs.readFileSync` / `statSync`，不渲染）：print.css 的链接/列表/h1/front matter clean 规则、两套 overrides 的 `#content a` 位于 `@media screen`、active 文本使用 `--ui-accent-strong`、front matter reset、`[data-ui-style]` 选择器、`--whale-ink` 已删除、`index.html` 首屏 reader、`src/Host/app.ico` > 5 KB。
   - `src/Host/Resources/index.html` 的 `data-ui-style="reader"` 保留；README 与 checklist 已注明「鲸鱼娘用户空白启动会先 reader→whale 切换一次（无本地存储策略）」。界面风格入口保留工具条按钮 + Aa 面板单选下拉，不新增控件。
9. **打印手测项（Minor）**
   - `docs/verify-checklist.md` §18 的 PDF 项补充：链接为正文色 + 下划线、鲸尾列表符号与 h1 装饰下边框隐藏；另增 front matter 表格双边框手测项。

### 11.2 测试

| 项 | 结果 |
| --- | --- |
| `cd web; npm test` | **21 files / 474 tests passed**（原 20 / 458，新增 `ui-css.test.js` 16 例） |
| `dotnet test tests/host/JingjingReader.Tests.csproj` | **376 passed / 0 failed / 0 skipped** |
| `pwsh -NoProfile -File scripts/build.ps1` | BUILD OK；`md-engine.js` 461.8 KB、内联 CSS 54680 字符 |
| `pwsh -NoProfile -File scripts/verify.ps1` | **VERIFY OK**（16 项：15 PASS + 1 既有 WARN，0 FAIL） |

verify 关键数据：full-syntax `elapsedMs=126 ms` / tocCount=38 / 端到端 1204 ms（既有 WARN 口径）；5 万行 `elapsedMs=187 ms` / tocCount=500 / 宿主私有内存峰值 165.7 MB；PDF hello 18787 B、5 万行 2314459 B / 1084 页；产物 472869 B × 2、SHA256 一致；双开单实例与用户数据隔离 PASS。

### 11.3 变更文件

`web/src/styles/{overrides-reader,overrides-whale,print}.css`、`web/src/ui-style.js`、`web/src/shell/toolbar.js`、`web/src/shell/main.js`（注释）、`src/Host/Resources/md-engine.js`（构建产物）、`src/Host/AboutWindow.xaml`、`README.md`、`docs/verify-checklist.md`、`docs/verify-record.md`、spec §5.2、`tests/web/ui-css.test.js`、`tests/web/ui-style.test.js`（测试描述）。

### 11.4 Concerns

1. **首屏一次风格切换**：`index.html` 固定 `data-ui-style="reader"`；无本地存储策略时无法在首屏前读到 `settings.json`，鲸鱼娘用户空白启动会看到一次 reader→whale 切换。已记录为已知取舍。
2. **手写 HTML 列表**：鲸尾符号基于 `#content > ul`，无法区分 markdown 列表与 raw HTML `<ul>`；按「不改渲染」约束选择接受并更正 checklist 文案。
3. **视觉仍需手测**：CSS 文本断言不能替代像素对比；active 文本对比度按色值计算（≈5.1:1），PDF 链接/鲸尾/h1 的实际效果需按 checklist §18 在真实窗口与 PDF 预览中确认。
4. **既有 WARN 未变**：端到端首屏 1204 ms，仍为 1000–2500 ms WARN 口径，本修复未触碰验收门槛。
