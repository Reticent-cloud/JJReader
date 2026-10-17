# 鲸鲸阅读器（Jingjing Reader）设计规格

- 日期：2026-10-17
- 状态：待用户评审（评审通过后才进入实施计划）
- 来源：brainstorming 会话（用户需求：做一个轻量、简易、易用的 Markdown 阅读器）
- 路径：`docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md`

---

## 1. 背景与目标

鲸鲸阅读器是一个 **Windows 桌面 Markdown 阅读器**：双击 `.md` 文件，1 秒内看到排版好的内容；读完关掉，全程不折腾。

目标（按优先级）：

1. **快**：热启动 ≤ 1.0 s 出首屏；总内存 ≤ 150 MB。
2. **准**：常见 Markdown（GFM、笔记体扩展、AI 生成的 README）渲染正确，不破版。
3. **顺**：阅读舒适——大纲跳转、主题、排版可调、位置记忆、大文档不卡。

不追求：功能大而全、笔记库管理、编辑能力。

---

## 2. 需求基线

### 2.1 用户明确的需求

| 维度 | 结论 |
|---|---|
| 形态 | Windows 桌面工具，双击 `.md` 直接使用（已确认：**要默认关联 `.md`**） |
| 范围 | 以单文件阅读为主，同时支持打开文件夹按目录浏览 |
| 语法 | GFM 标准语法；本地相对路径图片；内嵌 HTML；Obsidian/Typora 类扩展语法；AI 生成的 README 常见语法 |
| 明确不做 | 数学公式、Mermaid 图 |
| "轻"的定义 | 最不能接受**启动慢、内存胀**；安装包体积可让步 |
| 功能 | 大纲目录、主题切换（跟随系统）、排版调节（字号/行宽/字体）、阅读位置记忆 + 最近文件、大文档流畅、导出 PDF/打印 |

### 2.2 关键假设

| 编号 | 假设 |
|---|---|
| A1 | 单文件优先；不做笔记库级全文搜索与双链跳转，`[[xxx]]` 只做"当前文件夹内查找"的弱解析 |
| A2 | **只读**，不提供编辑能力 |
| A3 | 中文界面，Windows 10/11，纯本地离线；无账号、无联网、无云同步 |
| A4 | 不做多标签页（一次一个文件，通过最近列表切换） |
| A5 | **默认关联 `.md`**：注册 `HKCU\Software\Classes\JingjingReader.md` 并写入 `.md` 打开方式；受 Windows 10/11 限制，已被占用的关联需用户点一次「默认应用」确认，程序不做 hack 抢占。提供 `install.ps1` / `uninstall.ps1`（可完整恢复原状） |
| A6 | "大文档流畅"按 **5 万行 / ≈5 MB** 验收，不必支持 100 MB 级 |
| A7 | 联网图片（如 shields.io 徽章）离线时显示固定尺寸占位框，不破版、不阻塞 |
| A8 | v1 不做完整设置面板；偏好存本地配置文件，界面只暴露常用项（主题、字号、行距、行宽、字体） |

### 2.3 验收标准（可测）

1. 双击 `.md` → 首屏 ≤ **1.0 s**（热启动，文件已被系统缓存）。
2. 阅读 5 MB 文档时，任务管理器内本应用相关进程总内存 ≤ **150 MB**。
3. 第 5 节语法支持矩阵每一行有对应样例 MD 与自动化断言，全部通过。
4. 5 万行文档：滚动无长时间卡顿（单次滚动事件帧预算 < 16 ms），首屏 ≤ 1.5 s。
5. TOC 点击跳转位置正确；关闭再打开同一文件回到上次阅读位置。
6. 导出 PDF 与屏幕显示内容一致（分页合理、图片/表格/代码块不截断）。

---

## 3. 非目标（YAGNI，明确排除）

编辑、多标签页、跨文件全文搜索、云同步、插件系统、PDF/DOCX/其他格式阅读、移动端、导出 HTML/图片、数学公式渲染、Mermaid 图渲染、定义列表、主题市场、拖拽排序等。

（说明：单文件内的页内搜索 `Ctrl+F` 也不在本期范围，见 14-Q2。）

---

## 4. 架构

### 4.1 总体结构

单进程 WPF 应用 + 内嵌 WebView2。

```
┌────────────────────────────────────────────────────┐
│ 宿主层  C# / .NET 10 / WPF（约 300~400 行）          │
│  App        启动、命令行取文件、单实例转交            │
│  MainWindow 标准窗口 + WebView2 控件 + 拖放           │
│  FileHost   读文本、编码探测、虚拟主机映射            │
│  Store      settings / recent / positions (JSON)     │
│  PdfExport  CoreWebView2.PrintToPdfAsync             │
│  Assoc      HKCU 注册 ProgID + .md 打开方式           │
└──────────────▲─────────────────────────────────────┘
               │ postMessage(JSON) 双向
┌──────────────┴─────────────────────────────────────┐
│ 渲染层  HTML / CSS / JS（esbuild 打包后内嵌进 exe）   │
│  engine     markdown-it + 插件 → HTML                │
│  ext        扩展语法（wikilink / 高亮 / 注释 / TOC）  │
│  sanitize   DOMPurify 白名单                         │
│  highlight  highlight.js 定制语言集                  │
│  shell      TOC、主题、排版控件、阅读进度、错误条     │
└────────────────────────────────────────────────────┘
```

设计原则：**宿主极薄，UI 全在前端**。改样式只改 CSS；宿主只做系统级能力（文件、注册表、打印、单实例）。

### 4.2 宿主层模块

| 模块 | 职责 |
|---|---|
| `App` | 解析命令行（支持多个 `.md` 参数取第一个；支持 `--selftest`）；单实例（Mutex + 命名管道转交路径）；全局异常兜底 |
| `MainWindow` | 标准窗口（非无边框）、保存/恢复窗口几何、WebView2 初始化、拖放事件、悬浮工具条宿主行为 |
| `FileHost` | 路径规范化（相对→绝对、UNC、长路径 `\\?\`）；文本读取与编码探测；为文档所在目录建立 `https://md.local/` 虚拟主机映射 |
| `Store` | 三个 JSON 文件的原子读写与损坏恢复 |
| `PdfExport` | 调用 `PrintToPdfAsync`，输出到用户选择路径 |
| `Assoc` | 注册/注销 ProgID 与 `.md` 打开方式；生成跳转「默认应用」设置页的入口 |

### 4.3 渲染层模块

| 模块 | 职责 |
|---|---|
| `engine` | markdown-it 配置（`html: true`、`linkify`、`typographer`）+ 插件装配（footnote、task-lists、mark、emoji） |
| `ext` | 自定义规则：YAML front matter、`[[wikilink]]`、`![[附件]]`、`%%注释%%`、`[TOC]`、标题锚点 |
| `sanitize` | DOMPurify 白名单配置：允许语义标签与 `href/src/alt/title/align/width/height/colspan/rowspan/class/id/start`；移除 `script/style/iframe`、`on*` 事件、`javascript:` 协议 |
| `highlight` | highlight.js 定制语言集：js/ts/python/java/go/rust/csharp/bash/json/yaml/html/css/sql/diff/xml/markdown |
| `chunk` | 大文档分块渲染调度 |
| `shell` | TOC 生成与滚动联动、主题、排版调节、进度条、最近文件面板、错误条、快捷键（浏览器内部分） |

### 4.4 前后端接口契约

通信：`CoreWebView2.PostWebMessageAsJson` / `window.chrome.webview.postMessage`，消息体统一 `{type, payload}`。

| 方向 | type | payload |
|---|---|---|
| 宿主→前端 | `load` | `{path, key, baseUrl, markdown, settings, position}`；`key` = `sha1(路径|大小|修改时间)`，前端用它回传 `savePosition` |
| 宿主→前端 | `toast` | `{text, level}` |
| 宿主→前端 | `assocState` | `{registered, isDefault}` |
| 宿主→前端 | `dirListing` | `{path, entries:[{name, isDir, relPath}]}`（文件树子级） |
| 前端→宿主 | `openFile` | `{relPath}`（相对当前文档目录；TOC 内跨文件跳转） |
| 前端→宿主 | `pickFile` | `{}`（`Ctrl+O` 打开文件对话框） |
| 前端→宿主 | `pickFolder` | `{}` |
| 前端→宿主 | `listDir` | `{path}`（请求文件树子级） |
| 前端→宿主 | `savePosition` | `{key, ratio}`（`key` 由 `load` 下发，宿主据此定位 positions 记录） |
| 前端→宿主 | `saveSettings` | `{patch}`（部分更新） |
| 前端→宿主 | `readyToPrint` | `{}`（已进入打印模式，可调用 `PrintToPdfAsync`） |
| 前端→宿主 | `exportPdf` | `{suggestedName}` |
| 前端→宿主 | `showInFolder` | `{path}` |
| 前端→宿主 | `renderDone` | `{path, elapsedMs, tocCount, bytes}`（性能日志与验收用） |
| 前端→宿主 | `openDefaultApps` | `{}`（跳转 Windows 默认应用设置） |

### 4.5 关键技术决策

1. **本地资源用 WebView2 虚拟主机映射**：`SetVirtualHostNameToFolderMapping("md.local", 文档目录, DenyCors)` → 前端以 `https://md.local/...` 访问同目录图片与附件。原因：`file://` 在 WebView2 下受安全策略限制，且便于统一相对路径解析。切换到另一文档/目录时按需重建映射。
2. **大文档分块渲染**：Markdown 文本 > 512 KB 进入分块模式——按标题切块（单块 > 64 KB 时再按段落切），首屏只渲染前 256 KB 内容对应的块，`IntersectionObserver` 触发后续块渲染；TOC 在分块模式下由预扫描标题生成（不依赖渲染完）。> 20 MB 进入「大文件模式」：关闭语法高亮、关闭 TOC 实时联动，顶部显示提示条。
3. **宿主编译不依赖 Node**：前端产物 `md-engine.js`（含 CSS 字符串）入库到 `src/Host/Resources/`，作为 `EmbeddedResource` 打进 exe。只有修改前端才需要 `npm ci && node build.mjs`。
4. **编码探测顺序**：UTF-8 BOM → 严格 UTF-8 校验 → GB18030 → 兜底 UTF-8（有替换字符则提示"编码可能有问题"）。检测到 NUL 字节视为二进制文件并拒绝渲染。
5. **单实例**：`Mutex("Global\\JingjingReader")`；第二实例把命令行路径通过命名管道发给第一实例后退出，第一实例在原窗口打开新文件（不新开窗口）。
6. **安全模型**：所有 Markdown 内嵌 HTML 经 DOMPurify 清洗后才进入 DOM；WebView2 关闭开发者工具与外部导航（`NavigationStarting` 拦截非 `md.local`/`http(s)` 图片之外的导航）；`AreBrowserAcceleratorKeysEnabled=false`（快捷键由前端 keydown 统一处理，避免浏览器自身快捷键抢键）；开启 `IsWebMessageEnabled`，其余保持默认安全设置。

### 4.6 仓库结构

```
MDReader/
├─ src/Host/                        C# .NET 10 WPF 宿主
│  ├─ App.xaml(.cs)                 启动、单实例、异常兜底
│  ├─ MainWindow.xaml(.cs)          窗口、WebView2、拖放、消息收发
│  ├─ FileHost.cs                   路径/编码/虚拟主机
│  ├─ Store.cs                      settings/recent/positions
│  ├─ PdfExport.cs
│  ├─ Assoc.cs
│  └─ Resources/md-engine.js        前端构建产物（入库）
├─ web/                             前端源码
│  ├─ src/engine.js ext.js sanitize.js highlight.js chunk.js shell.js
│  ├─ src/styles/*.css
│  ├─ build.mjs                     esbuild 打包 → dist/
│  ├─ package.json                  仅 devDependencies（esbuild、vitest、jsdom、markdown-it 等）
│  └─ dist/                         本地构建输出（git 忽略）
├─ samples/                         验收样例 MD（每类语法 + 大文档生成脚本）
├─ tests/web/                       vitest 单测
├─ tests/host/                      宿主单元测试（xUnit）
├─ scripts/build.ps1                web 打包 → 拷贝资源 → dotnet publish
├─ scripts/verify.ps1               构建 + 单测 + 启动实测（耗时/内存/截图）
├─ scripts/install.ps1              注册 .md 关联
├─ scripts/uninstall.ps1            注销并恢复原状
└─ docs/superpowers/specs/          设计文档
```

---

## 5. 功能规格

### 5.1 窗口与布局

- 标准 Windows 窗口，标题 `文件名 — 鲸鲸阅读器`；最小尺寸 640×480；默认 1000×760。
- 记住窗口位置、大小、最大化状态。
- 关闭窗口即退出进程，**不驻留托盘、不保留后台进程**。
- 布局：左侧 TOC 侧栏（默认 240 px，可拖动 180–360 px，可折叠）＋ 中央正文列（默认最大行宽 780 px 居中）＋ 顶部悬浮工具条（鼠标移入顶部 40 px 区域或按 `Alt` 显示，移出 800 ms 后隐藏）＋ 右侧 3 px 阅读进度条。
- 滚离顶部 > 400 px 后，右下角出现「回到顶部」按钮。

### 5.2 工具条与快捷键

| 功能 | 快捷键 | 说明 |
|---|---|---|
| 打开文件 | `Ctrl+O` | 原生打开对话框，过滤 `.md/.markdown/.mdown/.txt` |
| 打开文件夹 | `Ctrl+Shift+O` | 选择目录作为浏览根 |
| 大纲开关 | `Ctrl+B` | 折叠/展开侧栏 |
| 主题切换 | — | 浅色 / 深色 / 跟随系统（三态循环） |
| 字号+/- | `Ctrl+=` / `Ctrl+-` | 14–24，步进 1 |
| 字号重置 | `Ctrl+0` | 回到 16 |
| 排版面板 | `Ctrl+,` | 字号、行距、行宽、字体 |
| 导出 PDF | `Ctrl+E` | 保存对话框 |
| 重载 | `F5` | 重新读文件并保持滚动位置 |
| 上一份/下一份 | `Alt+←` / `Alt+→` | 最近文件顺序切换 |
| 定位到文件 | `Ctrl+Shift+C` | 资源管理器打开所在目录 |
| 关闭浮层 | `Esc` | 关工具条/最近面板 |

### 5.3 大纲（TOC）

- 由 `h1–h6` 生成树形列表，缩进按级别；无标题的文档显示"此文档没有标题"。
- 当前阅读位置对应标题高亮（基于 `IntersectionObserver` + 滚动位置二分）。
- 点击平滑滚动到目标标题；长列表按需渲染（超过 300 项时使用简单虚拟滚动）。
- 目标标题带固定偏移，避免跳转后被悬浮工具条遮挡。
- `[TOC]` 占位符可在正文内生成一份扁平带层级的内联目录。

### 5.4 主题

- 三态：`light` / `dark` / `system`（默认 `system`，监听 `prefers-color-scheme` 实时切换）。
- 代码块、行内代码、表格、引用块、任务清单各有专属配色，深色下对比度不低于 WCAG AA（正文对比 ≥ 4.5:1）。
- 切换无白闪（先改 CSS 变量再重绘）。

### 5.5 排版调节

- 字号 14–24（默认 16）；行距 1.4–2.0（默认 1.7）；行宽 640 / 780 / 960 / 全宽（默认 780）。
- 字体：中文可选「系统默认（Segoe UI + 微软雅黑）/ 微软雅黑 / 思源黑体（若已安装）」；代码字体 Consolas / Cascadia Mono。
- 全部偏好持久化到 `settings.json`，重启保持。

### 5.6 最近文件与位置记忆

- 最近 20 项（路径、显示名、打开时间、文件大小），空白启动页与工具条菜单共用。
- 位置记忆键：`绝对路径 + 文件大小 + 最后修改时间`（三者哈希）。
- 恢复位置后右下角提示「已回到上次位置 · 回到顶部」，3 秒后消失；点击提示则回到顶部。
- 记录节流 500 ms；窗口关闭时强制 flush。

### 5.7 Markdown 语法支持矩阵

| 类别 | 支持项 | 行为 |
|---|---|---|
| GFM | ATX/Setext 标题、段落、加粗/斜体/删除线、嵌套列表、任务清单、表格（含对齐）、围栏代码块+高亮、行内代码、引用、链接/自动链接、图片、分隔线、脚注 `[^1]` | 标准渲染 |
| GFM 附加 | 标题锚点、页内 `#anchor` 跳转 | 自动生成 id |
| 笔记体 | YAML front matter | 默认隐藏；顶部"属性"折叠块可查看 |
| 笔记体 | `[[文件名]]` / `[[文件名\|别名]]` | 渲染为链接；点击在当前文档目录及子目录浅层（深度 ≤2）查找同名 `.md`，找到则打开，找不到顶部提示 |
| 笔记体 | `![[文件名]]` | 解析到当前目录/子目录文件则显示（图片内联，其他类型给文件名链接），否则占位框 |
| 笔记体 | `==高亮==` | `<mark>` |
| 笔记体 | `%%注释%%` | 不渲染 |
| 笔记体 | `[TOC]` | 就地生成内联目录 |
| AI README | shields.io 等网络图片 | 联网正常显示；失败显示同尺寸占位框（保留 alt 文本） |
| AI README | `<div align="center">`、`<img align="center">` | 保留对齐样式 |
| AI README | `<details><summary>` | 原生折叠，默认折叠 |
| AI README | `<br>` `<kbd>` `<sub>` `<sup>` `<p align>` | 正常渲染 |
| AI README | emoji（直接字符与 `:smile:` 短码） | 正常渲染 |
| AI README | 代码块超长行 | 横向滚动，不撑破布局；右上角「复制」按钮 |
| 不支持（原样文本） | 数学公式 `$...$` / `$$...$$`、Mermaid 代码块、定义列表、HTML 中的 `<script>`/`<style>`/`<iframe>` | 显示为纯文本或按清洗规则移除 |

### 5.8 大文档模式

| 阈值 | 模式 | 行为 |
|---|---|---|
| ≤ 512 KB | 普通 | 一次性渲染，高亮即时 |
| > 512 KB | 分块 | 首屏渲染前 256 KB，其余块滚动进入视口时渲染；TOC 由预扫描生成 |
| > 20 MB | 大文件 | 关闭高亮与 TOC 实时联动，顶部常驻提示条「大文件模式：已关闭代码高亮」 |

### 5.9 文件关联与单实例

- `install.ps1`：写 `HKCU\Software\Classes\JingjingReader.md`（含 `DefaultIcon`、`shell\open\command` 指向 `JingjingReader.exe "%1"`）、加入 `.md` 的 `OpenWithProgids`，并在「打开方式」中显示为**鲸鲸阅读器**。
- 若 `.md` 当前无默认程序，同时写入 `HKCU\Software\Classes\.md` 默认值；若已有默认程序，只加入打开方式并提示用户在「默认应用」中一键切换（提供按钮跳转 `ms-settings:defaultapps`）。
- `uninstall.ps1`：删除本程序写入的全部注册表项，恢复安装前备份的原值（安装时先备份到 `%APPDATA%\JingjingReader\assoc-backup.json`）。
- 单实例：第二次双击不新开窗口，转交给已运行窗口打开。

### 5.10 PDF 导出

- `Ctrl+E` → 保存对话框 → `CoreWebView2.PrintToPdfAsync`。
- 导出前临时切到打印样式：隐藏工具条/侧栏/回到顶部按钮，正文全宽、去背景色（可选保留）、代码块不截断。
- 纸张 A4，边距 12 mm，包含背景图形。
- 完成后打开所在目录并提示路径。

### 5.11 空白页与错误态

| 场景 | 表现 |
|---|---|
| 无参数启动 | 最近文件面板 + 拖放提示 + 「打开文件」按钮 |
| 文件不存在/无权限 | 顶部错误条（持续显示，可关闭）＋ 空状态说明 |
| 编码异常 | 尽力显示 + 提示条「文件编码可能不是 UTF-8，部分字符已替换」 |
| 二进制文件 | 拒绝渲染 + 提示 |
| 图片加载失败 | 固定 16:9 或按 `width/height` 的占位框 + alt 文本 |
| 前端渲染异常 | try/catch → 降级为 `<pre>` 纯文本 + 错误条（不白屏） |
| WebView2 运行时缺失 | 原生对话框说明 + 打开官方下载页按钮 |
| 文件被外部修改（重新打开或 F5） | 按新内容渲染；若位置键变化则回到顶部并提示 |

### 5.12 文件夹浏览

- `Ctrl+Shift+O` 或工具条「打开文件夹」选择目录后，该目录成为**浏览根**；侧栏切换为**文件树**模式（可一键切回大纲模式）。
- 文件树只列子目录与 `.md/.markdown/.mdown/.txt` 文件；目录在前、按名称排序，隐藏项与不可读项跳过。
- 子目录**惰性加载**：首次展开时请求 `listDir`，收到 `dirListing` 后填充；已加载节点不重复请求。
- 点击文件在当前窗口打开并在树中高亮；文件树内路径访问一律限制在浏览根内（越界拒绝）。
- 关闭目录浏览或打开新的单文件时，侧栏恢复大纲模式。

---

## 6. 数据流

### 6.1 打开文档

```
双击 .md
  → exe 启动（argv[1] = 路径）
  → 单实例检查：已有实例 → 经命名管道转交路径 → 本进程退出
  → 路径规范化 → 读取文本（编码探测）
  → 读取 settings / positions / recent
  → 建立 https://md.local/ → 文档目录 映射
  → WebView2 就绪后发送 load{path, baseUrl, markdown, settings, position}
  → 前端解析 → 渲染（或分块渲染）→ 生成 TOC
  → 前端 renderDone{elapsedMs}
  → 宿主写入 recent；渲染完成时如命中位置则应用并提示
  → 滚动时前端节流 500ms 发 savePosition；宿主节流写盘
  → 关闭：flush positions/settings → 退出
```

### 6.2 偏好与位置写入

- 前端 `saveSettings` 只发变化字段，宿主合并后原子写 `settings.json`。
- `savePosition` 由宿主合并进 `positions.json`，LRU 上限 500 条。
- 退出时若写盘失败，仅记录日志，不弹窗。

---

## 7. 持久化

目录：`%APPDATA%\JingjingReader\`（ASCII 路径，避免中文路径兼容问题）。

| 文件 | 结构（示例） | 上限 |
|---|---|---|
| `settings.json` | `{"theme":"system","fontSize":16,"lineHeight":1.7,"contentWidth":780,"cjkFont":"system","monoFont":"consolas","tocVisible":true,"tocWidth":240,"window":{"x":100,"y":80,"w":1000,"h":760,"max":false}}` | 单文件 |
| `recent.json` | `[{"path":"D:\\notes\\a.md","openedAt":"2026-10-17T09:12:00Z","size":10240}]` | 20 条 |
| `positions.json` | `[{"key":"<sha1(path|size|mtime)>","path":"...","ratio":0.42,"updatedAt":"..."}]` | 500 条 |
| `assoc-backup.json` | 安装前的 `.md` 关联原值，供卸载恢复 | 单文件 |
| `debug.log` | 启动耗时、渲染耗时、异常（滚动 3 份，每份 256 KB） | 3×256 KB |

写入策略：写 `xxx.json.tmp` → `File.Replace`/`Move` 原子替换；读取失败先备份为 `xxx.json.bak-<时间戳>`，再用默认值重建。

---

## 8. 构建与分发

- 工具链：.NET 10 SDK（已具备）、Node 24 / npm（已具备）、WebView2 Runtime（已具备）。
- `scripts/build.ps1`：
  1. `cd web && npm ci && node build.mjs`（esbuild → `web/dist/md-engine.js`）
  2. 拷贝产物到 `src/Host/Resources/`
  3. `dotnet publish src/Host -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true`
  4. 输出 `out/JingjingReader.exe`
- `scripts/build-selfcontained.ps1`：可选，打包 .NET 运行时（体积约 60–80 MB），供未装运行时的电脑使用。
- 默认发布形态：单文件 exe + 依赖系统 .NET 10 运行时；产物附 `install.ps1`/`uninstall.ps1` 与 `README.md`（安装/卸载/快捷键说明）。
- 版本信息写入 exe（产品名 `鲸鲸阅读器`，文件说明 `JingjingReader`），关于面板显示版本、.NET 版本、WebView2 版本。

---

## 9. 测试策略

TDD：先写测试，再写实现。

### 9.1 前端单测（vitest + jsdom）

- **语法矩阵逐条覆盖**：一个用例对应 5.7 表格的一行，断言生成 DOM 的结构与关键属性（不测样式）。
- **清洗安全用例**：`<script>`、`<iframe>`、`onclick`、`javascript:` 链接、`<style>` 注入均被移除；合法 `<details>`、`<img align>`、`<kbd>` 保留。
- **快照用例**：5 篇真实风格 README（AI 生成风格、徽章、居中头部、折叠块）整体快照。
- **性能冒烟**：生成 5 万行 Markdown，断言分块模式被触发、首块渲染耗时在 jsdom 下 < 300 ms（宽阈值防抖动）。
- **TOC 生成**：标题层级、重复标题去重 id、`[TOC]` 内联。
- **位置/设置消息**：断言 shell 发出的消息结构与节流行为（fake timers）。

### 9.2 宿主单测（xUnit）

- 编码探测：UTF-8 / UTF-8 BOM / GB18030 / 二进制 样例字节。
- 路径规范化：相对路径、UNC、中文路径、超长路径。
- Store：读写往返、原子写、损坏 JSON 的备份与重建、LRU 上限。
- Assoc：生成注册表写入命令字符串（不实际写注册表）。
- 单实例转交：命名管道的消息编解码。

### 9.3 集成验收（`scripts/verify.ps1`）

宿主提供以下验收用 CLI（`verify.ps1` 调用，正常使用不受影响）：
- `JingjingReader.exe --verify-render <file>`：隐藏窗口渲染后向 stdout 输出一行 JSON（`{ready, path, elapsedMs, tocCount}`）。
- `JingjingReader.exe --verify-pdf <file> <out.pdf>`：导出 PDF 后退出，退出码 0 表示成功。

1. 构建成功（前端 + 宿主）
2. 全部单测通过
3. `--verify-render samples/full-syntax.md`，断言 `elapsedMs` ≤ 1000 ms
4. `--verify-render samples/huge-50k-lines.md`，断言首屏 ≤ 1500 ms 且内存峰值 ≤ 150 MB（进程树采样）
5. `--verify-pdf` 导出到临时目录，断言文件存在且体积 > 5 KB
6. 并发启动两个实例，断言宿主进程数 = 1
7. 输出验收报告 `out/verify-report.md`

### 9.4 手动验收

按 2.3 六条逐项过；截图存档到 `docs/verify/`。

---

## 10. 性能与资源预算

| 指标 | 目标 | 上限 |
|---|---|---|
| 首屏（热启动，≤ 200 KB 文档） | 0.6 s | 1.0 s |
| 首屏（5 万行文档） | 1.0 s | 1.5 s |
| 总内存（5 MB 文档，稳定态） | 110 MB | 150 MB |
| 进程数 | 3（宿主 + 2 个 WebView2 进程） | 4 |
| 前端包体积（未压缩） | 350 KB | 500 KB |
| 安装包/exe 体积（依赖运行时） | 4 MB | 8 MB |

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| WebView2 内存高于预期 | 违反核心验收 | 单渲染进程；关闭不需要的 WebView2 特性与预渲染；实测后按需裁剪；必要时把"总内存"口径明确为进程树之和 |
| Windows 默认关联限制 | 无法静默接管 `.md` | 只写打开方式 + 引导「默认应用」一次确认；提供安装/卸载脚本与恢复 |
| 5 万行首屏超时 | 违反验收 | 分块渲染 + 高亮延后 + 预扫描轻量化；块大小可调参数集中在一处 |
| 笔记语法边界模糊 | 无限膨胀 | 严格按 5.7 矩阵实现；未知语法原样显示；新增语法必须带样例与测试 |
| Sanitizer 漏网 | 安全风险 | 使用 DOMPurify 而非手写；集中白名单配置并有安全用例 |
| 前端构建与 C# 构建耦合 | 构建失败 | 产物入库，`dotnet build` 不依赖 Node；仅前端改动时跑 build.mjs |
| Spec 与实现漂移 | 维护成本 | 语法矩阵 = 样例 MD = 单测，三者一一对应 |

---

## 12. 实施里程碑

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| M1 骨架可读 | WPF 窗口 + WebView2 初始化 + 命令行/拖放打开文件 + 编码探测 + GFM 主体渲染 + 基础样式 | 双击任意普通 `.md` 能正确阅读 |
| M2 语法完整 | 扩展语法（wikilink/高亮/注释/front matter/[TOC]）+ DOMPurify + highlight.js + 代码复制 + 全部语法单测绿 | 5.7 矩阵逐条有测试并通过 |
| M3 阅读体验 | TOC 与滚动联动、主题三态、排版调节、位置记忆、最近文件、分块渲染与大文件模式 | 5 万行文档流畅；关开回到原位 |
| M4 系统能力 | 文件关联 install/uninstall、单实例转交、PDF 导出、错误态与占位、关于面板 | 双击 `.md` 用鲸鲸阅读器打开；导出 PDF 正确 |
| M5 打磨验收 | 启动/内存实测与优化、verify.ps1、README、图标、版本信息 | 2.3 六条全部达标，验收报告产出 |

---

## 13. 命名与品牌

| 项 | 值 |
|---|---|
| 产品显示名 | 鲸鲸阅读器 |
| 窗口标题 | `<文件名> — 鲸鲸阅读器` |
| 可执行文件 | `JingjingReader.exe`（ASCII，脚本与注册表更稳） |
| 数据目录 | `%APPDATA%\JingjingReader\` |
| ProgID | `JingjingReader.md` |
| 图标 | v1 使用临时占位图标（`app.ico`），M5 前替换为鲸鱼图形；尺寸需含 16/32/48/256 |

---

## 14. 未决问题

| 编号 | 问题 | 处理 |
|---|---|---|
| Q1 | 正式图标设计（鲸鱼造型风格） | M5 前定；v1 先用占位，不阻塞开发 |
| Q2 | 是否需要页内搜索（`Ctrl+F`） | 本期不做，列为 v1.1 候选 |
| Q3 | 是否需要多标签页 | 本期不做，最近文件切换替代 |
| Q4 | 是否需要便携模式（配置随 exe 走，不写 AppData） | 本期不做；若需要，后续读取同目录 `portable.flag` 即可 |

以上未决问题均不阻塞 M1–M4。
