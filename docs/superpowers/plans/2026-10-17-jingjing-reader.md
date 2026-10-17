# 鲸鲸阅读器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Windows 桌面 Markdown 阅读器「鲸鲸阅读器」——双击 `.md` 1 秒内显示排版正确的内容，总内存 ≤150 MB，并具备大纲、主题、排版调节、位置记忆、PDF 导出与 `.md` 默认关联。

**Architecture:** 极薄 WPF 宿主（C#/.NET 10）承载 WebView2，全部解析/排版/UI 在前端完成；前端用 esbuild 打成单个 `md-engine.js` 作为嵌入资源入库，`dotnet build` 不依赖 Node。前后端只通过 10 条 JSON 消息通信。

**Tech Stack:** .NET 10 (WPF) + Microsoft.Web.WebView2；markdown-it 14.3.3 + footnote/task-lists/emoji 插件 + DOMPurify + highlight.js；esbuild 打包；vitest + jsdom 前端测试；xUnit 宿主测试。

**Spec:** `docs/superpowers/specs/2026-10-17-jingjing-markdown-reader-design.md`

## Global Constraints

- 平台：Windows 10/11 x64；`TargetFramework=net10.0-windows`、`UseWPF=true`；SDK 10.0.401（已安装）。
- 命名：界面显示名「鲸鲸阅读器」；exe `JingjingReader.exe`；数据目录 `%APPDATA%\JingjingReader\`；ProgID `JingjingReader.md`；命名空间 `JingjingReader`。
- 锁定依赖版本：`Microsoft.Web.WebView2` 1.0.4258.31、`markdown-it` 14.3.3、`markdown-it-footnote` 4.0.0、`markdown-it-task-lists` 2.1.1、`markdown-it-emoji` 3.1.0、`dompurify` 3.4.17、`highlight.js` 11.12.0、`esbuild` 0.28.2、`vitest` 5.0.5、`jsdom` 30.1.3、`xunit` 2.9.3、`Microsoft.NET.Test.Sdk` 18.11.0。
- 性能预算：热启动首屏目标 0.6 s / 上限 1.0 s；5 万行文档首屏上限 1.5 s；稳定态总内存上限 150 MB；进程数 ≤ 4；前端产物上限 500 KB（目标 350 KB）。
- 数值常量：分块阈值 512 KB、首屏渲染 256 KB、单块上限 64 KB、大文件模式 20 MB；字号 14–24 默认 16；行距 1.4–2.0 默认 1.7；行宽 640/780/960/全宽 默认 780；最近文件 20 条；位置记录 500 条、节流 500 ms；窗口默认 1000×760、最小 640×480；TOC 宽 240（可拖 180–360）。
- 界面文案中文；标识符与文件名英文（ASCII 路径）；提交信息中文，前缀 `feat:`/`test:`/`fix:`/`chore:`/`docs:`。
- 每个任务结束必须：本任务测试全绿 + 一次 git 提交。
- 明确不做（见 spec §3）：编辑、多标签页、跨文件全文搜索、页内搜索、公式、Mermaid、云同步、插件系统。

## Review Focus

以下 5 类输入/故障 spec 未逐条写死，但最可能伤到真实用户；对应测试必须落在括号中标注的任务里。

1. **文档路径含中文/空格/`#`/`%`**——相对图片与 wikilink 必须仍能打开（Task 3、Task 13）。
2. **分块边界切断代码围栏或表格**——每块必须围栏配对平衡、表格不被劈开（Task 11）。
3. **离线/无 DNS 时的网络图片（shields.io 徽章）**——必须快速失败换占位框，不阻塞首屏（Task 9）。
4. **两个进程同时双击启动**——只能出现一个窗口，另一个进程静默退出（Task 13）。
5. **深色主题下导出 PDF**——导出的 PDF 必须是浅色底、深色字（Task 15）。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/Host/JingjingReader.csproj` | WPF 宿主工程；嵌入 `Resources/md-engine.js`；锁定依赖 |
| `src/Host/App.xaml(.cs)` | 启动、命令行解析、单实例、全局异常、`--selftest/--verify-render/--verify-pdf` 分发 |
| `src/Host/MainWindow.xaml(.cs)` | 窗口、WebView2 初始化、消息收发、拖放、窗口几何 |
| `src/Host/Protocol.cs` | 前后端 JSON 消息构造与解析（唯一协议定义处） |
| `src/Host/FileHost.cs` | 路径规范化、扩展名判断、编码探测、文档读取、虚拟主机 URL 转换、相对资源解析（含目录穿越防护） |
| `src/Host/Store.cs` | `AppSettings/RecentEntry/PositionEntry` 记录类型 + 三个 JSON 的原子读写、LRU、损坏恢复 |
| `src/Host/IpcServer.cs` | 单实例命名管道（发/收文件路径） |
| `src/Host/NoteResolver.cs` | wikilink/附件在当前目录浅层查文件（深度 ≤2） |
| `src/Host/PdfExport.cs` | 打印设置与 `PrintToPdfAsync` 封装 |
| `src/Host/Assoc.cs` | HKCU 注册表读写抽象、ProgID 与打开方式、备份/恢复 |
| `src/Host/SelfTest.cs` | 环境自检文本（产品名/.NET/WebView2/OS） |
| `src/Host/AboutWindow.xaml(.cs)` | 关于面板（版本信息展示） |
| `src/Host/Resources/index.html` | 页面骨架（挂载点 + 内联脚本注入位） |
| `src/Host/Resources/md-engine.js` | 前端构建产物（入库） |
| `web/src/index.js` | 前端入口：装配 engine/shell 并暴露 `window.JJ` |
| `web/src/engine.js` | markdown-it 装配 + 渲染 + 标题提取 |
| `web/src/sanitize.js` | DOMPurify 白名单封装 |
| `web/src/highlight.js` | highlight.js 定制语言集 |
| `web/src/enhance.js` | 渲染后 DOM 增强：代码复制、图片占位、外链处理 |
| `web/src/ext/frontmatter.js` `wikilink.js` `highlight-mark.js` `comment.js` `attachment.js` `toc-placeholder.js` | 单个扩展语法各一文件 |
| `web/src/chunk.js` | 大文档切块与渐进渲染 |
| `web/src/toc.js` | TOC 生成与滚动联动 |
| `web/src/theme.js` `web/src/settings.js` | 主题三态、排版变量应用与偏好消息 |
| `web/src/shell/main.js` | 前端总装：消息收发、布局、快捷键、位置追踪（按需从 `shell/*.js` 引入） |
| `web/src/shell/recent.js` | 最近文件面板 |
| `web/src/styles/{base,layout,code,light,dark,print}.css` | 样式分层，打包时内联 |
| `web/build.mjs` | esbuild 打包（IIFE + CSS 内联）→ `dist/md-engine.js` |
| `web/vitest.config.mjs` | 测试 root 与 include（`../tests/web/**/*.test.js`，环境 jsdom） |
| `tests/host/*.cs` | xUnit 宿主测试 |
| `tests/web/*.test.js` | vitest 前端测试 |
| `samples/` | 验收样例 MD（语法矩阵逐条 + 真实 README 风 + 大文档生成脚本） |
| `scripts/build.ps1` `verify.ps1` `gen-huge-sample.ps1` `install.ps1` `uninstall.ps1` | 构建、验收、样例生成、关联安装/卸载 |

---

### Task 1: 仓库骨架、构建脚本与自检

**Files:**
- Create: `src/Host/JingjingReader.csproj`、`src/Host/App.xaml`、`src/Host/App.xaml.cs`、`src/Host/MainWindow.xaml`、`src/Host/MainWindow.xaml.cs`、`src/Host/SelfTest.cs`、`src/Host/ConsoleHelper.cs`、`src/Host/Resources/index.html`、`web/package.json`、`web/build.mjs`、`web/src/index.js`、`scripts/build.ps1`
- Create: `tests/host/JingjingReader.Tests.csproj`、`tests/host/SelfTestTests.cs`
- Test: `tests/host/SelfTestTests.cs`

**Interfaces:**
- Consumes: 无
- Produces: `JingjingReader.SelfTest.Format(string productName, string dotnetVersion, string webview2Version, string osVersion) -> string`（返回多行文本，至少含 `产品名:`、`.NET:`、`WebView2:`、`OS:` 四个键）；`JingjingReader.SelfTest.Run() -> string`；`scripts/build.ps1` 产出 `out/JingjingReader.exe`。

- [ ] **Step 1: 写失败测试** `tests/host/SelfTestTests.cs`

```csharp
[Fact]
public void Format_contains_all_required_keys() {
    var text = JingjingReader.SelfTest.Format("鲸鲸阅读器", "10.0.1", "155.0.4283.45", "10.0.19045");
    Assert.Contains("产品名: 鲸鲸阅读器", text);
    Assert.Contains(".NET: 10.0.1", text);
    Assert.Contains("WebView2: 155.0.4283.45", text);
    Assert.Contains("OS: 10.0.19045", text);
}
```

- [ ] **Step 2: 确认失败**：`dotnet test tests/host/JingjingReader.Tests.csproj --filter SelfTestTests` → 期望编译失败（`SelfTest` 不存在）。

- [ ] **Step 3: 实现骨架**
- `JingjingReader.csproj`：`<OutputType>WinExe</OutputType>`、`net10.0-windows`、`UseWPF`、`PackageReference Microsoft.Web.WebView2 1.0.4258.31`、`EmbeddedResource` 包含 `Resources\*`；保留默认 `App.xaml` 入口（不自定义 `Main`）。
- `web/package.json`：`"type": "module"`，`devDependencies` 按 Global Constraints 锁版本，scripts：`build`: `node build.mjs`、`test`: `vitest run`。
- `web/build.mjs`：esbuild 打包 `src/index.js` → `dist/md-engine.js`（format=iife，bundle，minify=false，loader 处理 css 为 text 并内联成 `<style>` 注入函数）。
- `web/src/index.js`：`window.JJ = { version: '0.1.0' }`（后续任务扩展）。
- `SelfTest.Format`：按 4 个键拼接；`Run()` 采集 `Environment.Version`、WebView2 运行时版本（读注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F1E7...}` 失败则 `未检测到`）、`Environment.OSVersion.Version.ToString()`。
- `App.xaml.cs`：`OnStartup` 按参数分发——含 `--selftest` 时 `ConsoleHelper.WriteLine(SelfTest.Run())` 后 `Shutdown(0)`（不创建窗口）；否则创建空主窗口（标题 `鲸鲸阅读器`）。
- `ConsoleHelper.cs`：P/Invoke `AttachConsole(ATTACH_PARENT_PROCESS)` 后 `Console.WriteLine`（WinExe 无自带控制台，需附着父进程控制台；附着失败则静默丢弃）。
- `scripts/build.ps1`：`npm ci`（web）→ `npm run build` → 拷 `dist/md-engine.js` 到 `src/Host/Resources/` → `dotnet publish` → 打印 `BUILD OK out\JingjingReader.exe`。

- [ ] **Step 4: 确认通过**：`dotnet test tests/host/JingjingReader.Tests.csproj --filter SelfTestTests` → PASS；`pwsh scripts/build.ps1` → 输出 `BUILD OK`；`out\JingjingReader.exe --selftest` 输出含 `产品名: 鲸鲸阅读器`。

- [ ] **Step 5: 提交**：`git add -A && git commit -m "feat: 仓库骨架、构建脚本与自检命令"`

---

### Task 2: Store（设置/最近/位置持久化）

**Files:**
- Create: `src/Host/Store.cs`、`tests/host/StoreTests.cs`
- Test: `tests/host/StoreTests.cs`（同一任务内按步骤逐步添加用例）

**Interfaces:**
- Consumes: 无
- Produces:
```csharp
public sealed record WindowGeometry(int X = 100, int Y = 80, int W = 1000, int H = 760, bool Max = false);
public sealed record AppSettings(string Theme = "system", int FontSize = 16, double LineHeight = 1.7,
    int ContentWidth = 780, string CjkFont = "system", bool TocVisible = true, int TocWidth = 240, WindowGeometry? Window = null);
public sealed record RecentEntry(string Path, string OpenedAt, long Size);
public sealed record PositionEntry(string Key, string Path, double Ratio, string UpdatedAt);
public sealed class Store {
    public Store(string dataDir);
    public string DataDir { get; }
    public AppSettings LoadSettings();
    public void SaveSettings(AppSettings settings);
    public IReadOnlyList<RecentEntry> LoadRecent();
    public void PushRecent(string path, long size, DateTimeOffset now);        // 去重后置顶，最多 20 条
    public IReadOnlyList<PositionEntry> LoadPositions();
    public void SavePosition(string key, string path, double ratio, DateTimeOffset now); // ratio 限制 [0,1]，LRU 500
    public double? FindPosition(string key);
    public static string ComputeKey(string normalizedPath, long size, DateTime lastWriteUtc); // sha1(小写路径|size|ticks)
}
```

- [ ] **Step 1: 写失败测试**（`StoreTests.cs`）

```csharp
[Fact] public void Settings_roundtrip_and_defaults() {
    var dir = TestDir(); var s = new Store(dir);
    Assert.Equal("system", s.LoadSettings().Theme);                 // 缺文件时给默认值
    s.SaveSettings(s.LoadSettings() with { Theme = "dark", FontSize = 20 });
    Assert.Equal(20, new Store(dir).LoadSettings().FontSize);
}
[Fact] public void Corrupt_json_is_backed_up_and_reset() {
    var dir = TestDir(); File.WriteAllText(Path.Combine(dir, "settings.json"), "{broken");
    var s = new Store(dir);
    Assert.Equal("system", s.LoadSettings().Theme);
    Assert.Single(Directory.GetFiles(dir, "settings.json.bak-*"));
}
[Fact] public void Recent_dedupes_caps_at_20() { /* PushRecent 21 次不同路径 + 重复 a.md，断言 20 条且 a.md 置顶 */ }
[Fact] public void Position_clamps_ratio_and_evicts_lru() { /* ratio 1.7 -> 1.0；501 条后最旧被淘汰 */ }
[Fact] public void ComputeKey_stable_and_case_insensitive_path() {
    var a = Store.ComputeKey(@"d:\Notes\A.md", 10, new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc));
    var b = Store.ComputeKey(@"D:\notes\a.md", 10, new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc));
    Assert.Equal(a, b);
}
```

- [ ] **Step 2: 确认失败**：`dotnet test tests/host/JingjingReader.Tests.csproj --filter StoreTests` → 编译失败。

- [ ] **Step 3: 实现 `Store`**
- JSON 用 `System.Text.Json`（`JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = CamelCase }`）。
- 原子写：写 `<name>.json.tmp` → `File.Move(tmp, target, overwrite: true)`；读失败时 `File.Move(target, "<name>.json.bak-" + UtcNow:yyyyMMddHHmmss)` 再返回默认值。
- `ComputeKey`：`Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant() + "|" + size + "|" + mtimeUtc.Ticks))).ToLowerInvariant()`（前 16 字符即可，测试不依赖长度）。
- LRU：读时按 `UpdatedAt` 倒序取前 N；写时去掉旧 key 再插入。

- [ ] **Step 4: 确认通过**：`--filter StoreTests` → 全部 PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: Store 持久化（设置/最近/位置，原子写与损坏恢复）"`

---

### Task 3: FileHost（路径规范化、编码探测、虚拟主机 URL）

**Files:**
- Create: `src/Host/FileHost.cs`、`tests/host/FileHostTests.cs`
- Test: `tests/host/FileHostTests.cs`

**Interfaces:**
- Consumes: `Store.ComputeKey`
- Produces:
```csharp
public sealed record DocumentRead(string Path, string Text, string EncodingName, bool HadBom, long Size,
    DateTime LastWriteUtc, string Key);
public static class FileHost {
    public static string NormalizePath(string input);            // 去引号空白；相对→绝对（基于 cwd）；长路径加 \\?\；统一 \
    public static bool IsMarkdown(string path);                  // .md/.markdown/.mdown/.mdx? 仅前三者 + .txt
    public static (string Text, string EncodingName, bool HadBom, bool IsBinary) Decode(byte[] bytes);
    public static DocumentRead ReadDocument(string filePath);     // 不存在/无权限抛标准异常
    public static string VirtualHostUrl(string docPath, string? relativeOrAbsolutePath); // → https://md.local/<已 URL 转义相对路径>
    public static string? ResolveInside(string docDir, string reference); // 规范化后必须仍在 docDir 内，越界返 null
}
```

- [ ] **Step 1: 写失败测试**

```csharp
[Theory]
[InlineData("C:\\notes\\中文 目录#1\\a.md")]        // 中文+空格+#
public void VirtualHostUrl_escapes_chinese_space_and_hash(string doc) {
    var url = FileHost.VirtualHostUrl(doc, "img/图 1.png");
    Assert.Equal("https://md.local/img/%E5%9B%BE%201.png", url);
}
[Fact] public void ResolveInside_rejects_traversal() {
    Assert.Null(FileHost.ResolveInside(@"C:\notes", @"..\..\windows\win.ini"));
    Assert.NotNull(FileHost.ResolveInside(@"C:\notes", @"sub\a.png"));
}
[Fact] public void Decode_utf8_bom_gb18030_binary() {
    Assert.True(FileHost.Decode(new byte[]{0xEF,0xBB,0xBF,(byte)'a'}).HadBom);
    Assert.Equal("中文", FileHost.Decode(Encoding.GetEncoding("GB18030").GetBytes("中文")).Text);
    Assert.True(FileHost.Decode(new byte[]{0x00,0x01,0x02}).IsBinary);
}
[Fact] public void ReadDocument_builds_key_and_metadata() { /* 临时文件写入 "# 标题\n" → Key 非空、Size>0、Text 含标题 */ }
```

- [ ] **Step 2: 确认失败**：`--filter FileHostTests` → 编译失败。

- [ ] **Step 3: 实现**
- `NormalizePath`：`Trim().Trim('"')` → `Path.GetFullPath`（相对 cwd）→ 若长度 > 255 或 UNC 加 `\\?\` 前缀（注意 WPF/File API 兼容）；`Path.GetFullPath` 后返回大写盘符形式。
- `Decode`：BOM 探测（UTF-8/UTF-16LE/BE）→ 严格 UTF-8（`new UTF8Encoding(false, true).GetString` try/catch）→ `Encoding.GetEncoding("GB18030")` → 兜底 UTF-8 替换；含 `\0` 判为二进制。
- `VirtualHostUrl`：取文档目录为根，`Path.GetRelativePath`，逐段 `Uri.EscapeDataString`（注意保留 `/`），拼接 `https://md.local/`。
- `ResolveInside`：`Path.GetFullPath(Path.Combine(docDir, reference))` 后 `StartsWith(docDir + "\\", OrdinalIgnoreCase)` 校验；绝对路径也走同一校验。
- `ReadDocument`：`File.ReadAllBytes` → `Decode` → `Key = Store.ComputeKey(NormalizePath, length, LastWriteTimeUtc)`。

- [ ] **Step 4: 确认通过**：`--filter FileHostTests` → PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: FileHost 路径规范化、编码探测与虚拟主机 URL"`

---

### Task 4: WebView2 宿主、消息协议与 `--verify-render`

**Files:**
- Create: `src/Host/Protocol.cs`、`src/Host/VerifyRender.cs`、`web/src/shell/main.js`、`tests/host/ProtocolTests.cs`、`tests/web/shell-boot.test.js`、`tests/web/setup.js`
- Modify: `src/Host/App.xaml.cs`、`src/Host/MainWindow.xaml(.cs)`、`src/Host/Resources/index.html`、`web/src/index.js`
- Test: `tests/host/ProtocolTests.cs`、`tests/web/shell-boot.test.js`

**Interfaces:**
- Consumes: `FileHost.ReadDocument`、`Store`
- Produces:
```csharp
// Protocol.cs —— 消息即字符串，type 与 payload 字段固定
public static class Protocol {
    public static string Load(string path, string key, string baseUrl, string markdown, AppSettings settings, double? position);
    public static string Toast(string text, string level = "info");
    public static string AssocState(bool registered, bool isDefault);
    public sealed record InboundMessage(string Type, string? Key, double Ratio, string? PatchJson, string? RelPath, string? SuggestedName, string? Path);
    public static InboundMessage ParseInbound(string json);   // 未知 type 抛 FormatException
}
```
```js
// web/src/index.js —— 前端 API 的唯一出口（后续任务逐个往这个对象上加成员）
export function install(target = {})
// 返回 API 对象并挂到 target.JJ（浏览器环境自动 install(window)）
// 本任务成员：version、mountShell
// 后续任务新增成员（各任务 Produces 声明）：renderMarkdown、extractHeadings(T5/T8)、sanitizeHtml(T7)、
// extractFrontmatter(T8)、enhance(T6/T9)、buildToc、createScrollSpy、applyTheme、applySettings、settingsPatch(T10)、
// splitBlocks、isHuge、createChunkedRenderer、CHUNK_THRESHOLD、HUGE_THRESHOLD(T11)、renderRecent、
// createPositionTracker、showToast、updateChrome(T12)、enterPrintMode(T15)
export function mountShell({ root, post })   // -> Shell；Shell.onMessage(msg) 接收 load / toast / assocState / dirListing
// 测试约定：tests/web/setup.js 执行 globalThis.JJ = install({})，全部用例通过 JJ.* 使用前端 API
```
- 消息契约（spec §4.4 的 10 条 + 本计划新增 4 条 = 14 条）：`load{path,key,baseUrl,markdown,settings,position}`、`toast{text,level}`、`assocState{registered,isDefault}`、`dirListing{path,entries:[{name,isDir,relPath}]}`、`openFile{relPath}`、`pickFile{}`、`pickFolder{}`、`listDir{path}`、`savePosition{key,ratio}`、`saveSettings{patch}`、`exportPdf{suggestedName}`、`readyToPrint{}`、`showInFolder{path}`、`openDefaultApps{}`、`renderDone{path,elapsedMs,tocCount,bytes}`。
- CLI：`JingjingReader.exe --verify-render <file>` → 隐藏窗口，收到 `renderDone` 后向 stdout 打一行 JSON `{"ready":true,"path":"...","elapsedMs":123,"tocCount":4}` 并退出 0；15 s 超时退出 2。

- [ ] **Step 1: 写失败测试**

```csharp
// ProtocolTests.cs
[Fact] public void Load_message_roundtrips_through_json() {
    var json = Protocol.Load(@"C:\a.md", "k1", "https://md.local/", "# hi", new AppSettings(), 0.5);
    using var doc = JsonDocument.Parse(json);
    Assert.Equal("load", doc.RootElement.GetProperty("type").GetString());
    Assert.Equal("https://md.local/", doc.RootElement.GetProperty("payload").GetProperty("baseUrl").GetString());
}
[Fact] public void ParseInbound_savePosition_and_unknown_type() {
    var m = Protocol.ParseInbound("""{"type":"savePosition","payload":{"key":"k","ratio":0.4}}""");
    Assert.Equal("savePosition", m.Type); Assert.Equal(0.4, m.Ratio);
    Assert.Throws<FormatException>(() => Protocol.ParseInbound("""{"type":"bogus"}"""));
}
```

```js
// tests/web/shell-boot.test.js
it('渲染 markdown 并回报 renderDone', () => {
  const root = document.createElement('div'); document.body.append(root);
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
  shell.onMessage({ type: 'load', payload: { path: 'a.md', key: 'k', baseUrl: 'https://md.local/', markdown: '# 标题\n正文', settings: {}, position: null } });
  const done = posted.find(m => m.type === 'renderDone');
  expect(done.payload.path).toBe('a.md');
  expect(done.payload.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(root.querySelector('#content').innerHTML).toContain('标题');
});
```

- [ ] **Step 2: 确认失败**：`dotnet test --filter ProtocolTests` 编译失败；`cd web; npm test -- shell-boot` 失败（`JJ` 未定义）。

- [ ] **Step 3: 实现**
- `Protocol`：`JsonSerializer.Serialize(new { type = "load", payload = new { ... } }, Options)`；`ParseInbound` 用 `JsonDocument` 按 type 取字段，未知 type 抛 `FormatException`；`payload.patch` 保留原始 JSON 文本供后续合并。
- `MainWindow`：`WebView2` 初始化用 `SetVirtualHostNameToFolderMapping("md.local", docDir, CoreWebView2HostResourceAccessKind.DenyCors)`；`CoreWebView2Settings` 设置 `AreBrowserAcceleratorKeysEnabled=false`（快捷键由前端 keydown 处理）、`AreDevToolsEnabled=false`、`IsStatusBarEnabled=false`、`IsZoomControlEnabled=false`、`IsPasswordAutosaveEnabled=false`；`WebMessageReceived` → `Protocol.ParseInbound` → 按 type 分派（本任务只实现 `savePosition` 写 Store、`renderDone` 写日志与回调）；`load` 用 `FileHost.ReadDocument` + `Protocol.Load` 推送；`index.html` 通过 `NavigateToString` 加载（读嵌入资源，把 `md-engine.js` 内联进 `<script>`）。
- `tests/web/setup.js`：`import { install } from '../../web/src/index.js'; globalThis.JJ = install({});` 并让 `web/vitest.config.mjs` 的 `setupFiles` 指向它（本任务创建 config，环境 jsdom）。
- `web/src/shell/main.js`：`mountShell({root, post})` 建 DOM 骨架 `#app > header#toolbar, aside#toc, main#content(scroller), div#toast`、`onMessage` 分发、`render` 计时并 `post('renderDone', ...)`、默认 renderer 用 `escapeHtml + <pre>`（Task 5 替换成 `JJ.renderMarkdown`）。
- `--verify-render`：`VerifyRender.Run(path, timeoutMs)` 启动隐藏 `MainWindow`（`ShowInTaskbar=false`、`Visibility=Hidden`、窗口尺寸 1000×760），等待 `renderDone`，Console 输出 JSON。
- `App` 增 `--verify-render` 分支；未知参数按文件路径处理。

- [ ] **Step 4: 确认通过**：`dotnet test --filter ProtocolTests` PASS；`cd web; npm test -- shell-boot` PASS；`pwsh scripts/build.ps1 && out\JingjingReader.exe --verify-render samples\hello.md`（新建 `samples/hello.md` 内容 `# 你好\n\n鲸鲸阅读器。`）→ 输出 `"ready":true`。

- [ ] **Step 5: 提交**：`git commit -m "feat: WebView2 宿主、JSON 协议与 verify-render 自检"`

---

### Task 5: 渲染引擎（markdown-it）与 GFM 基础语法

**Files:**
- Create: `web/src/engine.js`、`tests/web/engine-basic.test.js`
- Modify: `web/src/index.js`、`web/src/shell/main.js`、`web/package.json`、`web/vitest.config.mjs`（如需调整 include/setup）
- Test: `tests/web/engine-basic.test.js`

**Interfaces:**
- Consumes: `JJ.mountShell`
- Produces:
```js
// engine.js
export function renderMarkdown(markdown, env = {}) // env: { baseUrl, frontmatter }, 返回 HTML 字符串
export function extractHeadings(markdown)          // [{ id, text, level }]
export function slugify(text, usedIds)             // 中文保留，空格转 -
// index.js: window.JJ.renderMarkdown / window.JJ.extractHeadings 与 shell 内部使用同一实现
```

- [ ] **Step 1: 写失败测试**（`tests/web/engine-basic.test.js`，jsdom 环境）

```js
const html = (md) => JJ.renderMarkdown(md, { baseUrl: 'https://md.local/' });
it.each([
  ['# 一级标题', /<h1[^>]*>一级标题<\/h1>/],
  ['## 二级##', /<h2[^>]*>二级<\/h2>/],                  // Setext/尾井号
  ['**粗** *斜* ~~删~~', /<strong>粗<\/strong>.*<em>斜<\/em>.*<s>删<\/s>/s],
  ['- a\n  - b', /<ul>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/ul>/],
  ['1. a\n2. b', /<ol>[\s\S]*<\/ol>/],
  ['[链接](https://example.com)', /<a href="https:\/\/example.com">链接<\/a>/],
  ['https://example.com', /<a href="https:\/\/example.com"/],   // linkify
  ['![图](img/a.png)', /<img src="https:\/\/md\.local\/img\/a\.png" alt="图"/],
  ['> 引用', /<blockquote>[\s\S]*引用/],
  ['---', /<hr\s*\/?>/],
  ['`code`', /<code>code<\/code>/],
  ['\\*not em\\*', /\*not em\*/],
])('%s 渲染正确', (md, re) => expect(html(md)).toMatch(re));

it('标题生成稳定 id 且重复标题去重', () => {
  const h = JJ.extractHeadings('# 中文 标题\n# 中文 标题');
  expect(h).toHaveLength(2);
  expect(h[0].id).toBe('中文-标题');
  expect(h[1].id).not.toBe(h[0].id);
});
```

- [ ] **Step 2: 确认失败**：`cd web; npm test -- engine-basic` → 失败（`JJ.renderMarkdown` 返回 `<pre>`）。

- [ ] **Step 3: 实现**
- `engine.js`：单例 `MarkdownIt({ html: true, linkify: true, breaks: false })`；图片相对路径改写：`md.renderer.rules.image` 包装，`src` 以 `http(s)://`/`data:`/`#` 开头时保留，否则 `new URL(src, env.baseUrl).href`；标题 id：`core.ruler.push` 在 `heading_open` 上写 `id=slugify(text, used)`（`slugify` 保留中日韩字符与字母数字，空白→`-`，去标点，重复加 `-2`）。
- `extractHeadings`：用同一 markdown-it 实例 `parse` 后遍历 token，取 `heading_open` + `inline` 文本。
- `vitest.config.mjs`：`{ test: { environment: 'jsdom', include: ['../tests/web/**/*.test.js'], setupFiles: ['../tests/web/setup.js'] } }`；测试文件里用 `JJ.*` 访问 API。
- `shell/main.js`：`render` 改用 `JJ.renderMarkdown`，`post('renderDone', { path, elapsedMs, tocCount: JJ.extractHeadings(md).length, bytes })`。

- [ ] **Step 4: 确认通过**：`npm test -- engine-basic` PASS；`--verify-render` 时 `tocCount` 正确。

- [ ] **Step 5: 提交**：`git commit -m "feat: markdown-it 渲染引擎与 GFM 基础语法"`

---

### Task 6: GFM 完整语法（表格/任务清单/脚注/代码高亮）与代码复制

**Files:**
- Create: `web/src/highlight.js`、`web/src/enhance.js`、`tests/web/engine-gfm.test.js`
- Modify: `web/src/engine.js`（插件装配）、`web/src/shell/main.js`（渲染后调用 `enhance`）
- Test: `tests/web/engine-gfm.test.js`

**Interfaces:**
- Consumes: `JJ.renderMarkdown`
- Produces: `JJ.highlight(code, lang) -> string`（未注册语言返回转义原文）；`JJ.enhance(container, { baseUrl, onImageError })`（代码块加 `.code-wrap` + `button.copy`，复制成功/失败分别加 `data-copied`/`data-failed`；本任务仅代码复制与 `target=_blank` 外链处理）。

- [ ] **Step 1: 写失败测试**

```js
it('表格对齐保留到 th/td', () => {
  const html = JJ.renderMarkdown('| a | b |\n|:--:|--:|\n| 1 | 2 |');
  expect(html).toMatch(/<th[^>]*align="center"[^>]*>a<\/th>/);
  expect(html).toMatch(/<td[^>]*align="right"[^>]*>2<\/td>/);
});
it('任务清单生成 checkbox', () => {
  const html = JJ.renderMarkdown('- [ ] 未做\n- [x] 已做');
  expect(html).toMatch(/<input[^>]*type="checkbox"/);
  expect(html).toMatch(/<input[^>]*checked/);
});
it('脚注生成上标与回链', () => {
  const html = JJ.renderMarkdown('正文[^1]\n\n[^1]: 注解内容');
  expect(html).toMatch(/<sup[^>]*>.*<\/sup>/s); expect(html).toContain('注解内容');
});
it('代码块高亮并带语言类', () => {
  const html = JJ.renderMarkdown('```js\nconst a = 1;\n```');
  expect(html).toMatch(/<code[^>]*class="[^"]*language-js/);
  expect(html).toMatch(/<span class="hljs-/);
});
it('未闭合围栏不崩且按代码渲染', () => {
  const html = JJ.renderMarkdown('```js\nconst a = 1;');
  expect(html).toContain('const a = 1;');
});
it('代码块渲染后出现复制按钮且取到原文', () => {
  const root = document.createElement('div'); root.innerHTML = JJ.renderMarkdown('```js\nlet x=1;\n```');
  JJ.enhance(root, { baseUrl: 'https://md.local/' });
  const btn = root.querySelector('button.copy'); expect(btn).toBeTruthy();
  expect(btn.dataset.code).toContain('let x=1;');
});
```

- [ ] **Step 2: 确认失败**：`npm test -- engine-gfm` → 失败。

- [ ] **Step 3: 实现**
- `engine.js` 装配插件：`markdownItFootnote`、`markdownItTaskLists({ enabled: false, label: false })`（只读不写）、`markdownItEmoji`（full 版）；`highlight` 选项接 `highlight(code, lang)`。
- `highlight.js`：`hljs` core + `registerLanguage` 语言集（js/ts/python/java/go/rust/csharp/bash/json/yaml/xml/css/sql/diff/markdown），`highlight()` 内部 `hljs.getLanguage(lang)` 判断，失败回 `escapeHtml(code)`；渲染输出加 `class="hljs"`。
- `enhance.js`：`button.copy` 的点击用 `navigator.clipboard.writeText(btn.dataset.code)`（`catch` 时 `document.execCommand` 兜底并标记 `data-failed`）；外链 `<a href="http">` 加 `target="_blank" rel="noopener"`，点击通过宿主 `openFile`/系统浏览器处理（本任务只加属性）。
- 代码块 HTML 由自定义 `fence` renderer 输出：`<div class="code-wrap"><pre><code class="hljs language-x">…</code></pre><button class="copy" data-code="…">复制</button></div>`（`data-code` 用原始代码，`escapeAttr`）。

- [ ] **Step 4: 确认通过**：`npm test -- engine-gfm` PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: GFM 完整语法、代码高亮与复制按钮"`

---

### Task 7: HTML 清洗（DOMPurify 白名单）

**Files:**
- Create: `web/src/sanitize.js`、`tests/web/sanitize.test.js`
- Modify: `web/src/engine.js`（`renderMarkdown` 出口统一过 `sanitizeHtml`）
- Test: `tests/web/sanitize.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `export function sanitizeHtml(html, { allowDataImages = true } = {}) -> string`；白名单标签：`a,abbr,b,blockquote,br,center,code,dd,del,details,div,dl,dt,em,font,h1..h6,hr,i,img,input,kbd,li,mark,ol,p,pre,s,section,small,span,strong,sub,summary,sup,table,tbody,td,th,thead,tr,u,ul,aside`；属性白名单：`href,src,alt,title,align,width,height,colspan,rowspan,class,id,start,type,checked,disabled,loading,rel,target,open,style`（`style` 仅允许 `text-align|font-family|font-size|color|background`，其余剥离）；协议白名单：`http,https,mailto,md.local,data:image/`（`javascript:`、`vbscript:`、`file:` 一律移除）。

- [ ] **Step 1: 写失败测试**

```js
it.each([
  ['<script>alert(1)</script>', 'script'],
  ['<iframe src="x"></iframe>', 'iframe'],
  ['<div onclick="evil()">t</div>', 'onclick'],
  ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
  ['<img src="file:///c:/secret.png">', 'file:'],
])('移除危险内容 %s', (input, forbidden) => expect(JJ.sanitizeHtml(input)).not.toContain(forbidden));
it('保留安全结构', () => {
  const out = JJ.sanitizeHtml('<details open><summary>标题</summary><p align="center"><kbd>Ctrl</kbd><sub>2</sub></p></details><span style="color:red;position:fixed">x</span>');
  expect(out).toContain('<details open>'); expect(out).toContain('<kbd>Ctrl</kbd>');
  expect(out).toContain('align="center"'); expect(out).toContain('color:red');
  expect(out).not.toContain('position:fixed');
});
it('data:image 保留，data:text 移除', () => {
  expect(JJ.sanitizeHtml('<img src="data:image/png;base64,AAA">')).toContain('data:image/png');
  expect(JJ.sanitizeHtml('<a href="data:text/html,<b>x</b>">x</a>')).not.toContain('data:text/html');
});
```

- [ ] **Step 2: 确认失败**：`npm test -- sanitize` → `JJ.sanitizeHtml` 未定义。

- [ ] **Step 3: 实现**：`DOMPurify(window).sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: false, HOOKS })`；用 `afterSanitizeAttributes` hook 逐元素校验 `href/src` 协议，校验 `style` 属性按允许列表过滤（其余删除属性）；`engine.renderMarkdown` 返回 `sanitizeHtml(rendered)`。

- [ ] **Step 4: 确认通过**：`npm test -- sanitize` 与 `npm test -- engine-basic` 全部 PASS（渲染出口已加清洗，回归不破）。

- [ ] **Step 5: 提交**：`git commit -m "feat: DOMPurify 白名单清洗，保证内嵌 HTML 安全"`

---

### Task 8: 笔记体扩展语法（front matter / wikilink / 附件 / 高亮 / 注释）

**Files:**
- Create: `web/src/ext/frontmatter.js`、`web/src/ext/wikilink.js`、`web/src/ext/highlight-mark.js`、`web/src/ext/comment.js`、`web/src/ext/attachment.js`、`tests/web/ext-notes.test.js`
- Modify: `web/src/engine.js`（装配扩展插件）
- Test: `tests/web/ext-notes.test.js`

**Interfaces:**
- Consumes: `JJ.renderMarkdown(md, env)`
- Produces:
```js
// 各插件导出 install(md)，在 engine 装配时统一 md.use()
// frontmatter: 抽取后写入 env.frontmatter（对象），正文不渲染
// wikilink: [[note]] -> <a class="wikilink" data-target="note">note</a>
//            [[note|别名]] -> <a class="wikilink" data-target="note">别名</a>
// attachment: ![[img.png]] -> <img class="attachment" src="https://md.local/img.png" alt="img.png">
//             ![[doc.md]] -> <a class="attachment" data-target="doc.md">doc.md</a>
// highlight-mark: ==文本== -> <mark>文本</mark>
// comment: %%行内%% 与独占行的 %%块%% 不输出
export function extractFrontmatter(markdown) // -> { data: object, body: string }
```

- [ ] **Step 1: 写失败测试**

```js
it('front matter 从正文剥离并提取为数据', () => {
  const md = '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 正文';
  const html = JJ.renderMarkdown(md, { baseUrl: 'https://md.local/' });
  expect(html).not.toContain('title: 测试');
  expect(html).toContain('正文');
  expect(JJ.extractFrontmatter(md).data.title).toBe('测试');   // 解析失败时返回 {data:{}, body:md}
});
it('wikilink 生成链接与别名', () => {
  expect(JJ.renderMarkdown('见 [[笔记甲]]')).toContain('data-target="笔记甲"');
  expect(JJ.renderMarkdown('见 [[笔记甲|小甲]]')).toContain('>小甲</a>');
});
it('附件图片解析为虚拟主机地址，非图片输出链接', () => {
  expect(JJ.renderMarkdown('![[图 1.png]]', { baseUrl: 'https://md.local/' })).toContain('src="https://md.local/%E5%9B%BE%201.png"');
  expect(JJ.renderMarkdown('![[说明.md]]')).toContain('data-target="说明.md"');
});
it('==高亮== 与 %%注释%%', () => {
  expect(JJ.renderMarkdown('这是 ==重点==')).toContain('<mark>重点</mark>');
  expect(JJ.renderMarkdown('可见 %%隐藏%% 可见')).not.toContain('隐藏');
});
```

- [ ] **Step 2: 确认失败**：`npm test -- ext-notes` → 失败。

- [ ] **Step 3: 实现**
- `frontmatter`：`md.core.ruler.before('normalize', 'frontmatter', state => {…})` 用正则 `^---\r?\n([\s\S]*?)\r?\n---\r?\n` 截取，行级解析 `key: value`（值含 `[a, b]` 转数组、带引号去引号），写入 `state.env.frontmatter`。
- `wikilink`：`md.inline.ruler.before('link', 'wikilink', …)` 识别 `[[ … ]]`，`|` 分别名，输出 `link_open`/`text`/`link_close`（`href="#"`、`data-target`、`class="wikilink"`）。
- `attachment`：识别 `![[ … ]]`，按扩展名判定 `<img>`（`src` 相对 baseUrl 且逐段转义）或 `<a>`。
- `highlight-mark`：`md.inline.ruler.before('emphasis', 'mark', …)` 处理 `==…==`。
- `comment`：块级（整行 `%%...%%`）在 core 阶段删除 token；行内插件跳过 `%%…%%`。
- `extractFrontmatter` 同时供 shell 展示"属性"折叠块。

- [ ] **Step 4: 确认通过**：`npm test -- ext-notes` PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: 笔记体扩展语法（wikilink/附件/高亮/注释/front matter）"`

---

### Task 9: AI README 增强、`[TOC]` 内联、图片占位与标题锚点

**Files:**
- Create: `web/src/ext/toc-placeholder.js`、`tests/web/readme-enhanced.test.js`
- Modify: `web/src/enhance.js`（图片占位、离线快速失败）、`web/src/engine.js`（装配 toc-placeholder）、`web/src/shell/main.js`（渲染后 `enhance` + 挂载 front matter 折叠块）
- Test: `tests/web/readme-enhanced.test.js`

**Interfaces:**
- Consumes: `JJ.renderMarkdown`、`JJ.extractHeadings`、`enhance(container, {baseUrl})`
- Produces: `enhance(container, { baseUrl, onImageError })`；`[TOC]` 渲染为 `<nav class="toc-inline"><ol>…</ol></nav>`（层级按 `data-level` 缩进）；图片占位元素 `<span class="img-placeholder" data-alt="…" style="width:…;height:…">`（无法获知尺寸时 `aspect-ratio: 16/9`）。

- [ ] **Step 1: 写失败测试**

```js
it('details/summary 与内嵌语义标签保留', () => {
  const html = JJ.renderMarkdown('<details><summary>点开</summary><p align="center"><kbd>Ctrl</kbd>+<sub>2</sub><sup>+</sup></p></details>');
  expect(html).toContain('<details>'); expect(html).toContain('<summary>点开</summary>');
  expect(html).toContain('<kbd>Ctrl</kbd>');
});
it('emoji 短码与居中容器', () => {
  expect(JJ.renderMarkdown(':rocket: 发射')).toContain('🚀');
  expect(JJ.renderMarkdown('<div align="center"><img src="logo.png"></div>', { baseUrl: 'https://md.local/' })).toContain('align="center"');
});
it('[TOC] 就地生成层级目录', () => {
  const html = JJ.renderMarkdown('# 一\n\n[TOC]\n\n## 一.一');
  expect(html).toContain('class="toc-inline"');
  expect(html).toContain('data-level="2"');
});
it('图片加载失败替换为占位框（离线不破版）', () => {
  const root = document.createElement('div');
  root.innerHTML = JJ.renderMarkdown('![徽章](https://img.shields.io/badge/a-b-green)');
  JJ.enhance(root, { baseUrl: 'https://md.local/' });
  root.querySelector('img').dispatchEvent(new Event('error'));
  expect(root.querySelector('.img-placeholder')).toBeTruthy();
  expect(root.querySelector('.img-placeholder').dataset.alt).toBe('徽章');
});
it('标题锚点 id 与 extractHeadings 一致', () => {
  const md = '# 安装 步骤\n\n## 快速开始';
  const html = JJ.renderMarkdown(md);
  for (const h of JJ.extractHeadings(md)) expect(html).toContain(`id="${h.id}"`);
});
```

- [ ] **Step 2: 确认失败**：`npm test -- readme-enhanced` → 失败。

- [ ] **Step 3: 实现**
- `toc-placeholder`：块级规则匹配独占行 `[TOC]`，用 `extractHeadings(全文)` 生成 `<nav class="toc-inline">`（`<li data-level="n">` + 链接到 `#id`）。
- `enhance` 图片：给每个 `img` 加 `loading="lazy"`、`decoding="async"`；绑定 `error` 事件 → 替换为 `span.img-placeholder`（`data-alt` 保留 alt，`width/height` 若存在则沿用，否则 `.img-placeholder{aspect-ratio:16/9}`）；给 `img` 加 `onload` 移除占位（无需懒加载库）。
- front matter 折叠块：`shell/main.js` 在 `env.frontmatter` 非空时在 `#content` 顶部插入 `<details class="frontmatter"><summary>属性</summary><table>…</table></details>`。
- 标题锚点：Task 5 已生成 id，此处仅断言一致；`[TOC]` 与侧栏 TOC 共用 `extractHeadings`。

- [ ] **Step 4: 确认通过**：`npm test -- readme-enhanced` PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: README 增强语法、内联目录与图片占位"`

---

### Task 10: TOC 侧栏、滚动联动、主题三态与排版调节

**Files:**
- Create: `web/src/toc.js`、`web/src/theme.js`、`web/src/settings.js`、`web/src/styles/base.css`、`web/src/styles/layout.css`、`web/src/styles/light.css`、`web/src/styles/dark.css`、`tests/web/shell-ui.test.js`
- Modify: `web/src/shell/main.js`
- Test: `tests/web/shell-ui.test.js`

**Interfaces:**
- Consumes: `JJ.extractHeadings`、`JJ.mountShell`、`post`
- Produces:
```js
JJ.buildToc(headings) -> HTMLElement                       // <nav class="toc"><ol>…，无标题时返回空 nav；li[data-level]
JJ.createScrollSpy({ scroller, headings, onActive, thresholdPx = 80 }) -> { update(), destroy() }
  // headings: { id, text, level, top }[]（top 由 shell 渲染后从元素 offsetTop 采集）
JJ.applyTheme(theme, { matchMedia }) -> 'light'|'dark'     // theme: light|dark|system
JJ.applySettings(settings) -> void                        // 写 CSS 变量 --font-size/--line-height/--content-width/--font-cjk
JJ.settingsPatch(current, next) -> object                  // 只保留变化字段
```

- [ ] **Step 1: 写失败测试**

```js
it('TOC 按层级缩进，无标题返回空', () => {
  const nav = JJ.buildToc([{ id: 'a', text: 'A', level: 1, top: 0 }, { id: 'b', text: 'B', level: 2, top: 300 }]);
  expect(nav.querySelectorAll('a')).toHaveLength(2);
  expect(nav.querySelectorAll('li')[1].dataset.level).toBe('2');
  expect(JJ.buildToc([]).querySelectorAll('a')).toHaveLength(0);
});
it('主题三态解析 system 时跟随系统', () => {
  const mm = (dark) => ({ matches: dark, addEventListener() {}, removeEventListener() {} });
  expect(JJ.applyTheme('system', { matchMedia: () => mm(true) })).toBe('dark');
  expect(JJ.applyTheme('light', { matchMedia: () => mm(true) })).toBe('light');
});
it('applySettings 写 CSS 变量并夹紧范围', () => {
  JJ.applySettings({ fontSize: 99, lineHeight: 1.0, contentWidth: 960 });
  const s = document.documentElement.style;
  expect(s.getPropertyValue('--font-size')).toBe('24px');
  expect(s.getPropertyValue('--line-height')).toBe('1.4');
  expect(s.getPropertyValue('--content-width')).toBe('960px');
});
it('设置变更只上报差异字段', () => {
  expect(JJ.settingsPatch({ fontSize: 16, theme: 'system' }, { fontSize: 18, theme: 'system' })).toEqual({ fontSize: 18 });
});
it('滚动联动高亮当前标题', () => {
  const scroller = document.createElement('div');
  const headings = [{ id: 'a', text: 'A', level: 1, top: 0 }, { id: 'b', text: 'B', level: 2, top: 400 }];
  const active = [];
  const spy = JJ.createScrollSpy({ scroller, headings, onActive: (h) => active.push(h.id), thresholdPx: 80 });
  let top = 0; Object.defineProperty(scroller, 'scrollTop', { get: () => top });
  spy.update(); expect(active.at(-1)).toBe('a');
  top = 500; spy.update(); expect(active.at(-1)).toBe('b');
});
```

- [ ] **Step 2: 确认失败**：`npm test -- shell-ui` → 模块不存在。

- [ ] **Step 3: 实现**
- `buildToc`：`ol > li[data-level] > a[href=#id]`，点击 `preventDefault` + 平滑滚动（`scrollTo({ behavior: 'smooth' })`，目标位置减 80px 工具条高度）；`createScrollSpy` 用 `headings` 与 `scroller.scrollTop` 二分最近标题，`requestAnimationFrame` 节流。
- `theme.js`：`applyTheme` 解析 → `<html data-theme="light|dark">`，`system` 时订阅 `matchMedia('(prefers-color-scheme: dark)')` 的 `change`。
- `settings.js`：`applySettings` 夹紧到 Global Constraints 范围并写 CSS 变量；`settingsPatch` 深比较顶层字段。
- `styles`：`base.css` 定义变量与排版（正文字体栈、`max-width: var(--content-width)`、行高、`scroll-behavior`、`::selection`）；`light.css`/`dark.css` 用 `[data-theme]` 定义代码/表格/引用/任务清单配色（正文对比 ≥4.5:1）；`layout.css` 三栏网格与工具条/侧栏/回到顶部基础样式。
- `shell/main.js`：装配 TOC 侧栏（可在折叠状态）、主题按钮三态循环、`Aa` 面板（字号/行距/行宽/字体控件）、`Ctrl+B`/`Ctrl+=`/`Ctrl+-`/`Ctrl+0`/`Ctrl+,` 快捷键；设置变更 `post('saveSettings', { patch })`。
- `web/src/index.js`：`install()` 把 `buildToc/createScrollSpy/applyTheme/applySettings/settingsPatch` 挂到 `JJ`（浏览器与测试共用同一装配）。

- [ ] **Step 4: 确认通过**：`npm test -- shell-ui` PASS；`--verify-render samples\full-syntax.md`（后续样例）人工确认样式。

- [ ] **Step 5: 提交**：`git commit -m "feat: TOC 侧栏与滚动联动、主题三态与排版调节"`

---

### Task 11: 大文档分块渲染与大文件模式

**Files:**
- Create: `web/src/chunk.js`、`tests/web/chunk.test.js`
- Modify: `web/src/shell/main.js`（按阈值切换渲染策略）、`web/src/engine.js`（`renderMarkdown` 支持只渲染块）
- Test: `tests/web/chunk.test.js`

**Interfaces:**
- Consumes: `JJ.renderMarkdown`
- Produces:
```js
JJ.CHUNK_THRESHOLD = 512 * 1024;
JJ.INITIAL_BYTES = 256 * 1024;
JJ.MAX_BLOCK_BYTES = 64 * 1024;
JJ.HUGE_THRESHOLD = 20 * 1024 * 1024;
JJ.splitBlocks(markdown, { maxBlockBytes = JJ.MAX_BLOCK_BYTES } = {}) -> { blocks: string[], totalBytes: number }
JJ.isHuge(markdown) -> boolean
JJ.createChunkedRenderer({ container, render, blocks, initialBytes = JJ.INITIAL_BYTES, observerFactory }) -> { start(), renderedCount() }
  // observerFactory: (onIntersect: () => void) => { observe(el), disconnect() }；生产实现用 IntersectionObserver，测试传桩
```

- [ ] **Step 1: 写失败测试**

```js
it('不切断围栏代码块（每块围栏配对平衡）', () => {
  const fence = '```js\n' + 'const a = 1;\n'.repeat(4000) + '```\n';
  const { blocks } = JJ.splitBlocks(fence, { maxBlockBytes: 1024 });
  for (const b of blocks) {
    const fences = (b.match(/^```/gm) ?? []).length;
    expect(fences % 2).toBe(0);
  }
  expect(blocks.join('')).toBe(fence);          // 内容零丢失
});
it('不把表格行切到两块之外', () => {
  const table = '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(3000);
  for (const b of JJ.splitBlocks(table, { maxBlockBytes: 512 }).blocks) {
    if (b.includes('| 1 | 2 |')) expect(b.startsWith('| a | b |')).toBe(true); // 表头与数据在同一块
  }
});
it('大文件阈值判定', () => {
  expect(JJ.isHuge('a'.repeat(JJ.HUGE_THRESHOLD))).toBe(true);
  expect(JJ.isHuge('# hi')).toBe(false);
});
it('渐进渲染：首屏只渲染首块，观察器触发后续', () => {
  const container = document.createElement('div');
  let trigger = null;
  const observerFactory = (onIntersect) => { trigger = onIntersect; return { observe() {}, disconnect() {} }; };
  const r = JJ.createChunkedRenderer({ container, render: (md) => `<section>${md}</section>`, blocks: ['A', 'B', 'C'], initialBytes: 16, observerFactory });
  r.start();
  expect(r.renderedCount()).toBe(1);
  trigger();                                  // 模拟哨兵进入视口
  expect(container.innerHTML).toContain('B');
});
```

- [ ] **Step 2: 确认失败**：`npm test -- chunk` → 失败。

- [ ] **Step 3: 实现**
- `splitBlocks`：先按标题行切分（`^#{1,6}\s`），单块再按段落（空行）切，仍超长时按行切；**扫描围栏状态**（行以 ``` 或 ~~~ 开头）保证任何块边界都落在围栏外；表格块（连续 `|` 行）整体不切；切分后 `blocks.join('') === markdown`。
- `createChunkedRenderer`：首屏把累计字节 ≤ `initialBytes` 的块一次性渲染；其余插入 `<div class="chunk-sentinel">` 交给 `IntersectionObserver`，进入视口时渲染下一块（保持 DOM 顺序，用 `insertBefore` 插在哨兵前）。
- `shell/main.js`：`md.length > CHUNK_THRESHOLD` 走分块；`isHuge` 时 `document.body.classList.add('huge-mode')`（CSS 关闭高亮视觉、TOC 联动停用）并 `post('toast', { text: '大文件模式：已关闭代码高亮', level: 'warn' })`。

- [ ] **Step 4: 确认通过**：`npm test -- chunk` PASS；`pwsh scripts/gen-huge-sample.ps1` 生成 `samples/huge-50k-lines.md` 后 `--verify-render` 首屏 ≤1.5 s。

- [ ] **Step 5: 提交**：`git commit -m "feat: 大文档分块渲染与大文件模式"`

---

### Task 12: 最近文件、位置记忆与工具条交互

**Files:**
- Create: `web/src/shell/recent.js`、`tests/web/shell-ux.test.js`
- Modify: `web/src/shell/main.js`
- Test: `tests/web/shell-ux.test.js`

**Interfaces:**
- Consumes: `mountShell`、`createScrollSpy`、`settingsPatch`
- Produces:
```js
JJ.renderRecent(items) -> HTMLElement        // items: {path, name, dir, openedAt}[]，最多 20，键盘 ↑↓ + Enter
JJ.createPositionTracker({ scroller, key, emit, throttleMs = 500 }) -> { start(), flush(), destroy() }
JJ.showToast(text, level = 'info', { durationMs = 3000 } = {}) -> void
JJ.updateChrome({ scroller, progressEl, backToTopEl, thresholdPx = 400 }) -> void   // 进度条宽度 + 回到顶部按钮显隐
```

- [ ] **Step 1: 写失败测试**

```js
it('最近文件面板渲染并支持键盘选择', () => {
  const el = JJ.renderRecent([{ path: 'C:\\a.md', name: 'a.md', dir: 'C:\\', openedAt: '' }, { path: 'C:\\b.md', name: 'b.md', dir: 'C:\\', openedAt: '' }]);
  expect(el.querySelectorAll('[data-path]')).toHaveLength(2);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
});
it('位置上报节流 500ms 且 flush 立即发出', () => {
  vi.useFakeTimers();
  const sent = []; const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
  Object.defineProperty(scroller, 'clientHeight', { value: 1000 });
  Object.defineProperty(scroller, 'scrollTop', { value: 500, writable: true });
  const t = JJ.createPositionTracker({ scroller, key: 'k', emit: (key, ratio) => sent.push([key, ratio]) });
  t.start(); t.flush();
  expect(sent).toEqual([['k', 0.5]]);
  vi.useRealTimers();
});
it('toast 3 秒后自动消失', () => {
  vi.useFakeTimers(); JJ.showToast('提示'); expect(document.querySelector('.toast')).toBeTruthy();
  vi.advanceTimersByTime(3000); expect(document.querySelector('.toast')).toBeFalsy(); vi.useRealTimers();
});
it('滚动超过 400px 时显示回到顶部按钮', () => {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'scrollHeight', { value: 3000 });
  Object.defineProperty(scroller, 'clientHeight', { value: 800 });
  const progressEl = document.createElement('div'); const backToTopEl = document.createElement('button');
  backToTopEl.hidden = true;
  Object.defineProperty(scroller, 'scrollTop', { value: 100, writable: true });
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  expect(backToTopEl.hidden).toBe(true);
  scroller.scrollTop = 900;
  JJ.updateChrome({ scroller, progressEl, backToTopEl });
  expect(backToTopEl.hidden).toBe(false);
});

- [ ] **Step 2: 确认失败**：`npm test -- shell-ux` → 失败。

- [ ] **Step 3: 实现**
- `renderRecent`：列表项 `button[data-path]`（文件名 + 目录 + 相对时间），`↑↓` 移动焦点、`Enter` 触发 `post('openFile', { relPath })`（绝对路径时宿主按绝对处理）、`Esc` 关闭。
- `createPositionTracker`：`scroll` 事件节流 500 ms 计算 `scrollTop / (scrollHeight - clientHeight)` 并 `emit(key, ratio)`；`flush()` 立即发；`destroy()` 解绑。
- 工具条：悬浮显示（鼠标进入顶部 40 px 或 `Alt`），离开 800 ms 隐藏；滚动事件同时驱动 `JJ.updateChrome`（进度条宽度、`#back-to-top` 显隐）与位置追踪；`#back-to-top` 点击滚回顶部。
- 位置恢复：`load` 消息带 `position` 时 `scroller.scrollTop = ratio * (scrollHeight - clientHeight)`，并 `showToast('已回到上次位置 · 回到顶部')`（toast 可点击执行回到顶部）。

- [ ] **Step 4: 确认通过**：`npm test -- shell-ux` PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: 最近文件、位置记忆与工具条交互"`

---

### Task 13: 单实例、拖放、打开对话框与 wikilink 寻文件

**Files:**
- Create: `src/Host/IpcServer.cs`、`src/Host/NoteResolver.cs`、`tests/host/IpcTests.cs`、`tests/host/NoteResolverTests.cs`
- Modify: `src/Host/App.xaml.cs`、`src/Host/MainWindow.xaml(.cs)`、`src/Host/FileHost.cs`（按需）
- Test: `tests/host/IpcTests.cs`、`tests/host/NoteResolverTests.cs`

**Interfaces:**
- Consumes: `FileHost`、`Store`、`Protocol`
- Produces:
```csharp
public static class SingleInstance {
    public const string MutexName = "Global\\JingjingReader";
    public static bool TryAcquire();                       // true=我是主实例
    public static Task<bool> TrySendAsync(string path, int timeoutMs = 500); // 把路径发给主实例
}
public static class IpcServer {
    public static void Start(Action<string> onPath);       // 后台线程监听命名管道，收到路径回调
    public static Task<bool> SendAsync(string path, int timeoutMs = 500);
    public static void Stop();
}
public sealed record NoteHit(string FullPath, string RelativePath);
public static class NoteResolver {
    public static NoteHit? FindNote(string docDir, string target, int maxDepth = 2);      // 补 .md、大小写不敏感、跳过不可读目录
    public static NoteHit? FindAttachment(string docDir, string target, int maxDepth = 2);
}
```

- [ ] **Step 1: 写失败测试**

```csharp
[Fact] public async Task Ipc_roundtrip_delivers_path() {
    var got = new TaskCompletionSource<string>();
    IpcServer.Start(p => got.TrySetResult(p));
    Assert.True(await IpcServer.SendAsync(@"C:\notes\中文 目录#1\a.md"));
    Assert.Equal(@"C:\notes\中文 目录#1\a.md", await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
    IpcServer.Stop();
}
[Fact] public async Task Ipc_send_fails_without_server() { Assert.False(await IpcServer.SendAsync(@"C:\a.md", 200)); }
[Fact] public void NoteResolver_finds_note_in_subdir_case_insensitive() {
    var dir = TestDir(); Directory.CreateDirectory(Path.Combine(dir, "子目录"));
    File.WriteAllText(Path.Combine(dir, "子目录", "Note.md"), "# x");
    Assert.NotNull(NoteResolver.FindNote(dir, "note"));
    Assert.Equal("子目录/Note.md", NoteResolver.FindNote(dir, "Note")!.RelativePath.Replace('\\', '/'));
}
[Fact] public void NoteResolver_rejects_traversal_and_missing() {
    Assert.Null(NoteResolver.FindNote(@"C:\notes", @"..\..\windows\win.ini"));
    Assert.Null(NoteResolver.FindNote(@"C:\notes", "不存在"));
}
```

- [ ] **Step 2: 确认失败**：`--filter "IpcTests|NoteResolverTests"` → 编译失败。

- [ ] **Step 3: 实现**
- `SingleInstance`：`new Mutex(true, MutexName, out createdNew)` 保存字段防 GC；`TrySendAsync` 调 `IpcServer.SendAsync`。
- `IpcServer`：`NamedPipeServerStream(MutexName + ".pipe", PipeDirection.In, 1, PipeTransmissionMode.Byte)` 循环 `WaitForConnectionAsync`；`SendAsync` 用 `NamedPipeClientStream(".", pipe, PipeDirection.Out)` + `ConnectAsync(timeout)`，UTF-8 写一行路径。
- `App` 启动顺序：`--selftest`/`--verify-*` 优先；否则 `TryAcquire()` 失败 → `TrySendAsync(path)` → 退出；成功 → `IpcServer.Start(path => Dispatcher.Invoke(() => mainWindow.Open(path)))`。
- `MainWindow`：`AllowDrop=true`，`Drop` 事件取第一个文件；`openFile` 消息 → `FileHost` 校验存在 → 打开（绝对路径用 `NormalizePath`，相对路径 `ResolveInside` 到当前目录）；同时刷新虚拟主机映射（`ClearVirtualHostNameToFolderMapping` 后重设）。
- `wikilink` 点击：`enhance` 给 `.wikilink`/`.attachment[data-target]` 绑定点击 → `post('openFile', { relPath })`；宿主先 `NoteResolver.FindNote` 再打开，找不到 `Protocol.Toast("未找到「xxx」", "warn")`。

- [ ] **Step 4: 确认通过**：两个测试类 PASS；手动：连续双击两个 `.md` → 只出现一个窗口且内容切换。

- [ ] **Step 5: 提交**：`git commit -m "feat: 单实例转交、拖放、目录浏览与 wikilink 寻文件"`

---

```csharp
public static class SingleInstance {
    public const string MutexName = "Global\\JingjingReader";
    public static bool TryAcquire(string name = MutexName); // true=我是主实例；name 可注入便于测试
    public static Task<bool> TrySendAsync(string path, int timeoutMs = 500); // 把路径发给主实例
}
public static class IpcServer {
    public static void Start(string pipeName, Action<string> onPath);        // 后台线程监听命名管道
    public static Task<bool> SendAsync(string pipeName, string path, int timeoutMs = 500);
    public static void Stop();
}
public sealed record NoteHit(string FullPath, string RelativePath);
public static class NoteResolver {
    public static NoteHit? FindNote(string docDir, string target, int maxDepth = 2);      // 补 .md、大小写不敏感、跳过不可读目录
    public static NoteHit? FindAttachment(string docDir, string target, int maxDepth = 2);
}
```

- [ ] **Step 1: 写失败测试**

```csharp
[Fact] public async Task Ipc_roundtrip_delivers_path() {
    var pipe = "JingjingReaderTest." + Guid.NewGuid().ToString("N");
    var got = new TaskCompletionSource<string>();
    IpcServer.Start(pipe, p => got.TrySetResult(p));
    Assert.True(await IpcServer.SendAsync(pipe, @"C:\notes\中文 目录#1\a.md"));
    Assert.Equal(@"C:\notes\中文 目录#1\a.md", await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
    IpcServer.Stop();
}
[Fact] public async Task Ipc_send_fails_without_server() {
    Assert.False(await IpcServer.SendAsync("JingjingReaderTest." + Guid.NewGuid().ToString("N"), @"C:\a.md", 200));
}
[Fact] public void SingleInstance_detects_existing_mutex() {
    var name = "Local\\jj-test-" + Guid.NewGuid().ToString("N");
    using var held = new Mutex(false, name);
    held.WaitOne();                                    // 模拟另一个进程已持有
    Assert.False(SingleInstance.TryAcquire(name));
    held.ReleaseMutex();
}
[Fact] public void NoteResolver_finds_note_in_subdir_case_insensitive() {
    var dir = TestDir(); Directory.CreateDirectory(Path.Combine(dir, "子目录"));
    File.WriteAllText(Path.Combine(dir, "子目录", "Note.md"), "# x");
    Assert.Equal("子目录/Note.md", NoteResolver.FindNote(dir, "note")!.RelativePath.Replace('\\', '/'));
}
[Fact] public void NoteResolver_rejects_traversal_and_missing() {
    Assert.Null(NoteResolver.FindNote(@"C:\notes", @"..\..\windows\win.ini"));
    Assert.Null(NoteResolver.FindNote(@"C:\notes", "不存在"));
}
```

- [ ] **Step 2: 确认失败**：`--filter "IpcTests|NoteResolverTests"` → 编译失败。

- [ ] **Step 3: 实现**
- `SingleInstance`：`new Mutex(true, name, out createdNew)` 保存字段防 GC；`TrySendAsync` 调 `IpcServer.SendAsync(MutexName + ".pipe", path)`。
- `IpcServer`：`NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte)` 循环 `WaitForConnectionAsync`；`SendAsync` 用 `NamedPipeClientStream(".", pipeName, PipeDirection.Out)` + `ConnectAsync(timeout)`，UTF-8 写一行路径。
- `App` 启动顺序：`--selftest`/`--verify-*` 优先；否则 `TryAcquire()` 失败 → `TrySendAsync(path)` → 退出；成功 → `IpcServer.Start(MutexName + ".pipe", path => Dispatcher.Invoke(() => mainWindow.Open(path)))`。
- `MainWindow`：`AllowDrop=true`，`Drop` 事件取第一个文件；`openFile` 消息 → `FileHost` 校验存在 → 打开（绝对路径用 `NormalizePath`，相对路径 `ResolveInside` 到当前目录）；同时刷新虚拟主机映射（`ClearVirtualHostNameToFolderMapping` 后重设）；`pickFile`/`pickFolder` 消息 → `OpenFileDialog`/`OpenFolderDialog`（WPF `Microsoft.Win32.OpenFolderDialog`，.NET 8+ 内置），选中后按 `openFile` 路径打开；工具条按钮与 `Ctrl+O`/`Ctrl+Shift+O` 都走这两条消息。
- `wikilink` 点击：`JJ.enhance` 给 `.wikilink`/`.attachment[data-target]` 绑定点击 → `post('openFile', { relPath })`；宿主先 `NoteResolver.FindNote` 再打开，找不到 `Protocol.Toast("未找到「xxx」", "warn")`。

- [ ] **Step 4: 确认通过**：两个测试类 PASS；手动：连续双击两个 `.md` → 只出现一个窗口且内容切换；`Ctrl+O` 能打开文件。

- [ ] **Step 5: 提交**：`git commit -m "feat: 单实例转交、拖放、打开对话框与 wikilink 寻文件"`

---

### Task 14: 文件夹浏览（文件树侧栏）

**Files:**
- Create: `web/src/shell/tree.js`、`tests/web/tree.test.js`
- Modify: `web/src/shell/main.js`、`src/Host/Protocol.cs`、`src/Host/MainWindow.xaml(.cs)`
- Test: `tests/web/tree.test.js`、`tests/host/ProtocolTests.cs`（新增 listDir/dirListing 用例）

**Interfaces:**
- Consumes: `listDir` / `dirListing` 消息、`JJ.mountShell`
- Produces:
```js
JJ.renderTree(entries, { rootName, onOpen }) -> HTMLElement
  // entries: { name, isDir, relPath }[]；目录节点可展开（展开时 post('listDir', { path })，收到 dirListing 填充子级）
JJ.setSidebarMode(mode) -> void   // 'toc' | 'tree'；切换侧栏内容
```
```csharp
// Protocol 新增
public static string DirListing(string path, IEnumerable<(string Name, bool IsDir, string RelPath)> entries);
```

- [ ] **Step 1: 写失败测试**

```js
it('文件树渲染目录与文件节点，点击文件触发打开', () => {
  const opened = [];
  const el = JJ.renderTree([
    { name: '子目录', isDir: true, relPath: '子目录' },
    { name: 'a.md', isDir: false, relPath: 'a.md' },
  ], { rootName: 'notes', onOpen: (p) => opened.push(p) });
  expect(el.querySelectorAll('[data-rel]')).toHaveLength(2);
  el.querySelector('[data-rel="a.md"]').click();
  expect(opened).toEqual(['a.md']);
});
it('目录节点展开时请求 listDir', () => {
  const posted = [];
  const el = JJ.renderTree([{ name: 'sub', isDir: true, relPath: 'sub' }], { rootName: 'notes', onOpen() {}, post: (t, p) => posted.push([t, p]) });
  el.querySelector('[data-rel="sub"]').click();
  expect(posted[0]).toEqual(['listDir', { path: 'sub' }]);
});
```

```csharp
[Fact] public void DirListing_serializes_entries() {
    var json = Protocol.DirListing(@"C:\notes", new[] { ("a.md", false, "a.md"), ("sub", true, "sub") });
    using var doc = JsonDocument.Parse(json);
    Assert.Equal("dirListing", doc.RootElement.GetProperty("type").GetString());
    Assert.Equal(2, doc.RootElement.GetProperty("payload").GetProperty("entries").GetArrayLength());
}
```

- [ ] **Step 2: 确认失败**：`npm test -- tree` 失败；`dotnet test --filter DirListing` 编译失败。

- [ ] **Step 3: 实现**
- 宿主：`MainWindow` 收到 `listDir` → 校验路径在当前浏览根内（`FileHost.ResolveInside`）→ 列出子目录与 `.md/.markdown/.mdown/.txt` 文件（目录在前、名称排序、跳过隐藏与不可读项）→ `Protocol.DirListing` 推回。
- 前端 `renderTree`：`ul > li[data-rel]`，目录节点带三角展开按钮，首次展开发 `listDir`、`dirListing` 到达后按路径填子级（`data-loaded` 标记防重复）；点击文件 `onOpen(relPath)`；当前文件高亮 `.active`。
- `shell/main.js`：`pickFolder` 后设置浏览根、`setSidebarMode('tree')`、工具条显示根目录名并可一键切回 `toc`。

- [ ] **Step 4: 确认通过**：`npm test -- tree` PASS；`dotnet test --filter DirListing` PASS；手动 `Ctrl+Shift+O` 打开 `samples/` → 侧栏出现文件树，点击可打开。

- [ ] **Step 5: 提交**：`git commit -m "feat: 打开文件夹与文件树侧栏浏览"`

---

### Task 15: PDF 导出与打印样式

**Files:**
- Create: `src/Host/PdfExport.cs`、`web/src/print.js`、`tests/host/PdfExportTests.cs`、`tests/web/print.test.js`
- Modify: `web/src/shell/main.js`（`exportPdf` 消息处理时进入打印模式）、`web/src/styles/print.css`
- Test: `tests/host/PdfExportTests.cs`、`tests/web/print.test.js`

**Interfaces:**
- Consumes: `CoreWebView2`
- Produces:
```csharp
public sealed record PdfOptions(double PageWidthIn = 8.27, double PageHeightIn = 11.69, double MarginIn = 0.472, bool PrintBackgrounds = true); // A4, 12mm
public static class PdfExport {
    public static PdfOptions Default { get; }
    public static Task<bool> ExportAsync(CoreWebView2 webView, string outputPath); // 等待前端打印模式消息后调用 PrintToPdfAsync
}
```
```js
JJ.enterPrintMode({ document }) -> () => void    // 加 body.print-mode + 强制浅色，返回退出函数
JJ.enterPrintModeForPdf() -> void                // 调 enterPrintMode，退出函数存 window.__jjPrintExit，再经 JJ.__post 发 readyToPrint
JJ.exitPrintModeForPdf() -> void                 // 调用并清空 window.__jjPrintExit
// mountShell 内部把 post 记到 JJ.__post，供打印流程使用
```

- [ ] **Step 1: 写失败测试**

```csharp
[Fact] public void Default_is_a4_with_12mm_margin() {
    Assert.Equal(8.27, PdfExport.Default.PageWidthIn, 2);
    Assert.Equal(11.69, PdfExport.Default.PageHeightIn, 2);
    Assert.Equal(0.472, PdfExport.Default.MarginIn, 3);
    Assert.True(PdfExport.Default.PrintBackgrounds);
}
```

```js
it('打印模式隐藏工具条与侧栏并强制浅色', () => {
  document.body.innerHTML = '<header id="toolbar"></header><aside id="toc"></aside><main id="content">x</main>';
  const exit = JJ.enterPrintMode({ document });
  expect(document.body.classList.contains('print-mode')).toBe(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  exit();
  expect(document.body.classList.contains('print-mode')).toBe(false);
});
it('导出流程：进入打印模式后回报 readyToPrint', () => {
  const root = document.createElement('div'); document.body.append(root);
  const posted = [];
  JJ.mountShell({ root, post: (type) => posted.push(type) });
  JJ.enterPrintModeForPdf();
  expect(posted).toContain('readyToPrint');
  expect(typeof window.__jjPrintExit).toBe('function');
  JJ.exitPrintModeForPdf();
  expect(window.__jjPrintExit).toBeUndefined();
});
```

- [ ] **Step 2: 确认失败**：两个测试失败（类型/函数不存在）。

- [ ] **Step 3: 实现**
- `PdfExport.ExportAsync`：`await webView.ExecuteScriptAsync("window.JJ.enterPrintModeForPdf()")` → 等待前端 `readyToPrint`（`TaskCompletionSource` 由 `MainWindow` 消息分派触发，超时 5 s）→ `PrintToPdfAsync(outputPath, settings)`，`PrintSettings` 换算英寸，`ShouldPrintBackgrounds=true` → `ExecuteScriptAsync("window.JJ.exitPrintModeForPdf()")` 恢复界面。
- `print.js`：`enterPrintMode` 切 `body.print-mode` + `documentElement.dataset.theme='light'`；`print.css`：`@page { size: A4; margin: 12mm }`、`.print-mode #toolbar, .print-mode #toc, .print-mode #back-to-top { display:none }`、`pre { white-space: pre-wrap; word-break: break-all }`（代码不截断）、`table { page-break-inside: avoid }`、图片 `max-width:100%`。
- `MainWindow`：`exportPdf` 消息 → 保存对话框（默认文件名 `<文档名>.pdf`）→ `PdfExport.ExportAsync` → 成功 `showInFolder` + toast，失败 toast 错误。

- [ ] **Step 4: 确认通过**：`--verify-pdf samples\hello.md out\hello.pdf` → 退出 0 且 PDF > 5 KB；`npm test -- print` PASS。

- [ ] **Step 5: 提交**：`git commit -m "feat: PDF 导出（打印样式、A4/12mm、深色主题强制浅色）"`

---

### Task 16: 文件关联（安装/卸载）与关于面板

**Files:**
- Create: `src/Host/Assoc.cs`、`src/Host/AboutWindow.xaml(.cs)`、`scripts/install.ps1`、`scripts/uninstall.ps1`、`tests/host/AssocTests.cs`
- Modify: `src/Host/App.xaml.cs`（`--install` / `--uninstall` 分发）、`src/Host/MainWindow.xaml(.cs)`（关于入口）
- Test: `tests/host/AssocTests.cs`

**Interfaces:**
- Consumes: `Store`（备份文件）
- Produces:
```csharp
public interface IAssocRegistry {              // 便于单测的注册表抽象
    string? GetValue(string keyPath, string? valueName);
    void SetValue(string keyPath, string? valueName, string value);
    void DeleteKey(string keyPath);
}
public static class Assoc {
    public const string ProgId = "JingjingReader.md";
    public const string FriendlyName = "鲸鲸阅读器";
    public static string CommandValue(string exePath);        // "\"C:\\…\\JingjingReader.exe\" \"%1\""
    public static string ProgIdKey();                          // "Software\\Classes\\JingjingReader.md"
    public static string DotMdKey();                            // "Software\\Classes\\.md"
    public static void Install(IAssocRegistry reg, string exePath, string backupJsonPath);
    public static void Uninstall(IAssocRegistry reg, string backupJsonPath);
}
public static string AboutInfo.Format(string product, string version, string dotnet, string webview2, string osVersion);
```

- [ ] **Step 1: 写失败测试**

```csharp
[Fact] public void Command_quotes_exe_and_percent_1() {
    Assert.Equal("\"C:\\apps\\JingjingReader.exe\" \"%1\"", Assoc.CommandValue(@"C:\apps\JingjingReader.exe"));
}
[Fact] public void Install_writes_progid_openwith_and_backup() {
    var reg = new FakeRegistry(); var backup = Path.Combine(TestDir(), "assoc-backup.json");
    Assoc.Install(reg, @"C:\apps\JingjingReader.exe", backup);
    Assert.Equal(Assoc.FriendlyName, reg.GetValue(@"Software\Classes\JingjingReader.md", null));
    Assert.Equal(Assoc.CommandValue(@"C:\apps\JingjingReader.exe"), reg.GetValue(@"Software\Classes\JingjingReader.md\shell\open\command", null));
    Assert.Equal(Assoc.ProgId, reg.GetValue(@"Software\Classes\.md\OpenWithProgids", Assoc.ProgId));
    Assert.True(File.Exists(backup));
}
[Fact] public void Uninstall_restores_previous_default_and_removes_keys() { /* 先 Install，再 Uninstall，断言 ProgID 键被删、.md 默认值恢复为备份值 */ }
[Fact] public void AboutInfo_contains_all_fields() {
    var text = AboutInfo.Format("鲸鲸阅读器", "0.1.0", "10.0.1", "155.0.4283.45", "10.0.19045");
    Assert.Contains("鲸鲸阅读器 0.1.0", text); Assert.Contains("WebView2 155.0.4283.45", text);
}
```

- [ ] **Step 2: 确认失败**：`--filter AssocTests` → 编译失败。

- [ ] **Step 3: 实现**
- `Assoc.Install`：读旧值（`.md` 默认值、`.md\OpenWithProgids`）→ 写入 `backup.json` → 写 ProgID（默认值=友好名、`DefaultIcon`=exe 路径、`shell\open\command`）→ 写 `.md\OpenWithProgids\<ProgId>`；若 `.md` 无默认值，另写 `HKCU\Software\Classes\.md` 默认值为 ProgId。
- `Win32AssocRegistry : IAssocRegistry` 用 `Microsoft.Win32.Registry.CurrentUser`。
- `scripts/install.ps1`：调用 `JingjingReader.exe --install` → 打印提示（若 `.md` 已有默认程序，引导用户打开 `ms-settings:defaultapps`）。
- `scripts/uninstall.ps1`：`--uninstall` → 删除注册表项并恢复备份。
- `AboutWindow`：显示 `AboutInfo.Format(...)`（产品/版本/.NET/WebView2/OS）+ 按钮：打开默认应用设置、打开数据目录、检查 `.md` 关联状态（`assocState` 消息）。

- [ ] **Step 4: 确认通过**：`--filter AssocTests` PASS；手动执行 `pwsh scripts/install.ps1` 后右键 `.md` 可见「鲸鲸阅读器」，`uninstall.ps1` 后消失。

- [ ] **Step 5: 提交**：`git commit -m "feat: .md 关联安装/卸载与关于面板"`

---

### Task 17: 性能实测、验收脚本、README 与图标

**Files:**
- Create: `scripts/verify.ps1`、`scripts/gen-huge-sample.ps1`、`README.md`、`src/Host/app.ico`、`src/Host/app.manifest`、`tests/web/perf.test.js`
- Modify: `src/Host/JingjingReader.csproj`（`ApplicationIcon`、版本号、`ApplicationManifest`）、`scripts/build.ps1`
- Test: `tests/web/perf.test.js` + `scripts/verify.ps1` 输出

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `scripts/verify.ps1` → 打印 `VERIFY OK` 或失败项；`out/verify-report.md`；`README.md`（安装/使用/快捷键/卸载/构建）。

- [ ] **Step 1: 写失败测试**

```js
it('5 万行文档切块耗时可控且零丢失', () => {
  const md = Array.from({ length: 50000 }, (_, i) => `第 ${i} 行内容`).join('\n');
  const t0 = performance.now(); const { blocks } = JJ.splitBlocks(md);
  const ms = performance.now() - t0;
  expect(blocks.join('')).toBe(md);
  expect(ms).toBeLessThan(300);
});
it('前端产物体积不超过 500KB', async () => {
  const { statSync } = await import('node:fs');
  const size = statSync(new URL('../../web/dist/md-engine.js', import.meta.url)).size;
  expect(size).toBeLessThanOrEqual(500 * 1024);
});
```

- [ ] **Step 2: 确认失败**：`npm test -- perf`（若 `dist/` 未构建先 `npm run build`）→ 初始可能因产物缺失失败。

- [ ] **Step 3: 实现**
- `scripts/gen-huge-sample.ps1`：生成 `samples/huge-50k-lines.md`（5 万行、含若干标题与代码块、约 2–4 MB）。
- `scripts/verify.ps1`：①`scripts/build.ps1` ②`dotnet test` ③`cd web; npm test` ④`JingjingReader.exe --selftest` ⑤`--verify-render samples/hello.md` 断言 `elapsedMs<1000` ⑥`--verify-render samples/huge-50k-lines.md` 断言 `<1500` + 进程树内存峰值采样（`Get-Process -Name JingjingReader,msedgewebview2` 求和 < 150 MB）⑦`--verify-pdf` 断言产物 >5 KB ⑧前端产物 ≤500 KB ⑨并发双实例检查：同时启动两个 exe 打开不同文件，断言 `JingjingReader` 进程数 = 1 ⑩写 `out/verify-report.md`。
- `app.manifest`：`PerMonitorV2` DPI 感知；`app.ico`：临时占位鲸鱼图标（16/32/48/256）；csproj 加 `ApplicationIcon`、`ApplicationManifest`、`<Version>`、`<Product>鲸鲸阅读器</Product>`、`<AssemblyName>JingjingReader</AssemblyName>`。
- `README.md`：一句话介绍、安装（`install.ps1`）、使用与快捷键表、构建（`build.ps1`）、卸载、验收（`verify.ps1`）、目录结构。

- [ ] **Step 4: 确认通过**：`pwsh scripts/verify.ps1` → `VERIFY OK`，报告中的 6 项验收全部达标；`npm test` 全绿。

- [ ] **Step 5: 提交**：`git commit -m "chore: 验收脚本、性能实测、README 与图标占位"`

---

## 里程碑映射

| 里程碑（spec §12） | 任务 |
|---|---|
| M1 骨架可读 | Task 1–5 |
| M2 语法完整 | Task 6–9 |
| M3 阅读体验 | Task 10–12 |
| M4 系统能力 | Task 13–16 |
| M5 打磨验收 | Task 17 |

## 依赖关系（哪些任务必须串行）

- Task 1 → 其余全部（骨架与构建）
- Task 2、3 之后才能做 Task 4；Task 4 之后才能做 Task 5（前端装配）与 Task 10–12
- Task 5 → 6 → 7 → 8 → 9（同一渲染管线，按序落地）
- Task 10 → 11 → 12（shell 逐步扩展；11 依赖 10 的滚动容器）
- Task 13 依赖 3+4；Task 14 依赖 13（复用 openFile 通道）；Task 15 依赖 4；Task 16 依赖 1；Task 17 依赖全部
