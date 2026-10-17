using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace JingjingReader;

/// <summary>
/// 主窗口：极薄宿主 —— 承载 WebView2、维护「md.local → 文档目录」虚拟主机映射、
/// 与前端收发 <c>{type, payload}</c> JSON 消息。解析/排版/UI 全部在前端，宿主只做系统级能力。
/// </summary>
public partial class MainWindow : Window
{
    /// <summary>虚拟主机名（spec §4.5：<c>https://md.local/</c> 指向当前文档目录）。</summary>
    private const string VirtualHostName = "md.local";

    /// <summary>index.html 里等待宿主内联 md-engine.js 的占位标签。</summary>
    private const string EnginePlaceholder = "<script id=\"md-engine\"></script>";

    private const string DataDirectoryName = "JingjingReader";

    private readonly Store _store;
    private readonly string _webViewDataFolder;

    private Task? _webViewInitialization;
    private bool _shellReady;
    private bool _virtualHostMapped;
    private string? _pendingDocumentPath;
    private DocumentRead? _currentDocument;

    /// <summary>前端完成一次渲染（来自 <c>renderDone</c> 消息；--verify-render 与 debug 日志使用）。</summary>
    public event Action<InboundMessage>? RenderDone;

    public MainWindow()
    {
        InitializeComponent();

        var appData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            DataDirectoryName);
        _store = new Store(appData);
        _webViewDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            DataDirectoryName,
            "WebView2");

        Loaded += OnLoaded;
    }

    /// <summary>
    /// 在当前窗口打开文档：记住待打开的路径，等 WebView2 就绪且前端 shellReady 后推送 load。
    /// Task 13 起拖放、文件对话框、wikilink 跳转复用同一入口。
    /// </summary>
    public void OpenDocument(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        _pendingDocumentPath = filePath;
        TryPushPendingDocument();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        try
        {
            await EnsureWebViewInitializedAsync();
            TryPushPendingDocument();
        }
        catch (Exception exception)
        {
            // 窗口初始化是 UI 顶层边界：WebView2 运行时缺失/初始化失败时记录并提示，
            // 不让异常冒泡成未处理异常（原生错误对话框由 Task 16 负责）。
            DebugLog.Write($"WebView2 初始化失败：{exception}");
            ConsoleHelper.WriteLine($"ERROR WebView2 初始化失败：{exception.Message}");
        }
    }

    private Task EnsureWebViewInitializedAsync() => _webViewInitialization ??= InitializeWebViewAsync();

    private async Task InitializeWebViewAsync()
    {
        // userDataFolder 固定到 %LOCALAPPDATA%\JingjingReader\WebView2（目录不存在则创建）。
        Directory.CreateDirectory(_webViewDataFolder);

        var environment = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: _webViewDataFolder);
        await WebView.EnsureCoreWebView2Async(environment);

        var core = WebView.CoreWebView2;
        var settings = core.Settings;

        // 快捷键由前端 keydown 统一处理：关掉浏览器自身快捷键、开发者工具、状态栏缩放与自动填充，
        // 避免 Ctrl+O/Ctrl+= 等被 WebView2 抢走或弹出保存密码提示。
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.AreDevToolsEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsGeneralAutofillEnabled = false;

        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigateToString(BuildPageHtml());

        DebugLog.Write("WebView2 初始化完成，页面已导航");
    }

    private void TryPushPendingDocument()
    {
        if (!_shellReady || _pendingDocumentPath is not { } path)
        {
            return;
        }

        _pendingDocumentPath = null;
        PushDocument(path);
    }

    private void PushDocument(string filePath)
    {
        var normalizedPath = FileHost.NormalizePath(filePath);
        DocumentRead document;
        try
        {
            document = FileHost.ReadDocument(normalizedPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // 文件不存在/无权限/路径非法：保持窗口可用，前端给错误提示（错误条在 Task 12 完善）。
            DebugLog.Write($"打开文档失败 path={normalizedPath} error={exception}");
            Title = $"{Path.GetFileName(normalizedPath)} — 鲸鲸阅读器";
            Post(Protocol.Toast($"无法打开文件：{Path.GetFileName(normalizedPath)}", "error"));
            return;
        }

        _currentDocument = document;
        Title = $"{Path.GetFileName(document.Path)} — 鲸鲸阅读器";
        UpdateVirtualHostMapping(document.Path);

        var settings = _store.LoadSettings();
        var position = _store.FindPosition(document.Key);
        var isBinary = string.Equals(document.EncodingName, "binary", StringComparison.Ordinal);

        DebugLog.Write(
            $"load path={document.Path} encoding={document.EncodingName} hadBom={document.HadBom} " +
            $"size={document.Size} binary={isBinary}");

        // 二进制文件不渲染正文：给前端空 markdown + toast 拒绝提示（DocumentRead 以 encoding=binary 为信号）。
        Post(Protocol.Load(
            document.Path,
            document.Key,
            FileHost.VirtualHostUrl(document.Path, relativeOrAbsolutePath: null),
            isBinary ? string.Empty : document.Text,
            settings,
            position));

        if (isBinary)
        {
            Post(Protocol.Toast("该文件不是文本文件，已拒绝渲染", "warn"));
        }

        // 只有可渲染的文本文档才记入最近文件（裁定 4）：二进制拒绝渲染时 recent.json 与前端列表都保持原样。
        // 空白启动页与 Alt+←/→ 依赖最近列表，点击一个只会被拒绝的文件没有意义。
        if (RecentPolicy.ShouldRecord(document))
        {
            RememberRecent(document);
        }
    }

    /// <summary>把当前文档写入 recent.json（失败只记日志），随后把最新列表推给前端。</summary>
    private void RememberRecent(DocumentRead document)
    {
        try
        {
            _store.PushRecent(document.Path, document.Size, DateTimeOffset.UtcNow);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            DebugLog.Write($"写入最近文件失败 path={document.Path}：{exception.Message}");
        }

        PostRecent();
    }

    /// <summary>
    /// 把最近文件（最新在前，最多 20 条）推给前端：空白启动时渲染「最近文件」面板，
    /// 打开文档后供 Alt+←/→ 切换。显示名/目录在宿主侧算好，前端不做路径解析。
    /// </summary>
    private void PostRecent()
    {
        if (!_shellReady)
        {
            return;
        }

        try
        {
            var items = _store.LoadRecent()
                .Select(entry => (
                    Path: entry.Path,
                    Name: Path.GetFileName(entry.Path),
                    Dir: Path.GetDirectoryName(entry.Path) ?? string.Empty,
                    OpenedAt: entry.OpenedAt))
                .ToList();
            Post(Protocol.Recent(items));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            DebugLog.Write($"读取最近文件失败：{exception.Message}");
        }
    }

    /// <summary>
    /// 把 <c>md.local</c> 映射到文档所在目录（前端访问相对图片/附件）。切换文档先清除旧映射再重设。
    /// </summary>
    private void UpdateVirtualHostMapping(string docPath)
    {
        var core = WebView.CoreWebView2;
        var normalizedPath = FileHost.NormalizePath(docPath);
        var directory = Path.GetDirectoryName(normalizedPath);
        if (string.IsNullOrWhiteSpace(directory))
        {
            directory = Path.GetPathRoot(normalizedPath);
        }

        if (string.IsNullOrWhiteSpace(directory))
        {
            DebugLog.Write($"无法确定文档目录，跳过虚拟主机映射：{normalizedPath}");
            return;
        }

        if (_virtualHostMapped)
        {
            try
            {
                core.ClearVirtualHostNameToFolderMapping(VirtualHostName);
            }
            catch (InvalidOperationException exception)
            {
                DebugLog.Write($"清除虚拟主机映射失败：{exception.Message}");
            }

            _virtualHostMapped = false;
        }

        _virtualHostMapped = TryMapVirtualHost(core, directory);
        if (!_virtualHostMapped && HasExtendedPathPrefix(directory))
        {
            // FileHost.NormalizePath 对超长路径/UNC 会加 \\?\ / \\?\UNC\ 前缀，WebView2 对扩展路径
            // 可能报错：去掉扩展前缀后重试（映射只看目录本身，去掉前缀不改变可访问范围）。
            var plainDirectory = RemoveExtendedPathPrefix(directory);
            _virtualHostMapped = TryMapVirtualHost(core, plainDirectory);
            if (_virtualHostMapped)
            {
                DebugLog.Write($"虚拟主机映射改用无扩展前缀目录 {plainDirectory}");
            }
        }
    }

    /// <summary>设置虚拟主机映射；失败只记日志（图片加载不到不应阻断正文渲染）。</summary>
    private static bool TryMapVirtualHost(CoreWebView2 core, string directory)
    {
        try
        {
            core.SetVirtualHostNameToFolderMapping(
                VirtualHostName,
                directory,
                CoreWebView2HostResourceAccessKind.DenyCors);
            DebugLog.Write($"虚拟主机映射 {VirtualHostName} → {directory}");
            return true;
        }
        catch (Exception exception)
        {
            // UI 边界：WebView2 可能对非法目录抛 ArgumentException/COMException，映射失败不阻断渲染。
            DebugLog.Write($"虚拟主机映射失败 {directory}：{exception.Message}");
            return false;
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        InboundMessage message;
        try
        {
            message = Protocol.ParseInbound(e.WebMessageAsJson);
        }
        catch (Exception exception) when (exception is FormatException or InvalidOperationException)
        {
            // 坏消息只记日志：绝不能让一条前端消息把宿主带崩。
            DebugLog.Write($"忽略无法解析的前端消息：{exception.Message}");
            return;
        }

        try
        {
            Dispatch(message);
        }
        catch (Exception exception)
        {
            // UI 事件边界：磁盘写失败等异常只记日志，不弹窗、不中断阅读。
            DebugLog.Write($"处理前端消息 {message.Type} 失败：{exception}");
        }
    }

    private void Dispatch(InboundMessage message)
    {
        switch (message.Type)
        {
            case "shellReady":
                // 握手完成，前端监听器已就绪：现在推 load 不会丢（见 Protocol 注释）。
                _shellReady = true;
                DebugLog.Write("shellReady");
                TryPushPendingDocument();
                // 无论是否推了 load 都发最近文件：空白启动页要靠它渲染面板。
                PostRecent();
                break;

            case "renderDone":
                DebugLog.Write(
                    $"renderDone path={message.Path} elapsedMs={message.ElapsedMs:0.##} " +
                    $"tocCount={message.TocCount} bytes={message.Bytes}");
                RenderDone?.Invoke(message);
                break;

            case "savePosition":
                SavePosition(message);
                break;

            case "saveSettings":
                SaveSettings(message);
                break;

            case "openFile":
                OpenFile(message.RelPath);
                break;

            case "reload":
                ReloadCurrentDocument();
                break;

            case "showInFolder":
                ShowInFolder(message.Path);
                break;

            default:
                // 其余契约消息（pickFile/pickFolder/listDir/exportPdf/readyToPrint/openDefaultApps）
                // 属 Task 13–16，本任务只记日志。
                DebugLog.Write($"忽略消息 type={message.Type}");
                break;
        }
    }

    /// <summary>saveSettings{patch}：把补丁合并进当前设置后原子落盘（只接受类型匹配的已知字段）。</summary>
    private void SaveSettings(InboundMessage message)
    {
        if (string.IsNullOrWhiteSpace(message.PatchJson))
        {
            DebugLog.Write("忽略 saveSettings：缺少 patch");
            return;
        }

        var current = _store.LoadSettings();
        var merged = SettingsPatch.Apply(current, message.PatchJson);
        _store.SaveSettings(merged);
        DebugLog.Write($"saveSettings patch={message.PatchJson}");
    }

    /// <summary>
    /// openFile：绝对路径直接使用；相对路径相对当前文档目录解析（越界拒绝）。
    /// 最近文件面板与 Alt+←/→ 传绝对路径，wikilink/文件树的相对路径（Task 13）复用同一入口。
    /// </summary>
    private void OpenFile(string? relPath)
    {
        if (string.IsNullOrWhiteSpace(relPath))
        {
            DebugLog.Write("忽略 openFile：缺少 relPath");
            Post(Protocol.Toast("无法打开文件：缺少路径", "error"));
            return;
        }

        string? target = null;
        try
        {
            if (Path.IsPathFullyQualified(relPath))
            {
                target = FileHost.NormalizePath(relPath);
            }
            else if (_currentDocument is { } document)
            {
                var directory = Path.GetDirectoryName(document.Path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    target = FileHost.ResolveInside(directory, relPath);
                }
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            DebugLog.Write($"openFile 路径非法 relPath={relPath}：{exception.Message}");
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            DebugLog.Write($"openFile 无法解析 relPath={relPath}");
            Post(Protocol.Toast("无法打开文件：路径不在当前文档目录内", "error"));
            return;
        }

        OpenDocument(target);
    }

    /// <summary>reload（F5）：重新读取当前文档并推送；位置按新文件的 key 重新查找（文件被外部修改则回到顶部）。</summary>
    private void ReloadCurrentDocument()
    {
        if (_currentDocument is not { } document)
        {
            DebugLog.Write("忽略 reload：当前没有打开的文档");
            return;
        }

        PushDocument(document.Path);
    }

    /// <summary>showInFolder：资源管理器定位到文件（失败只记日志，不弹窗）。</summary>
    private static void ShowInFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            DebugLog.Write("忽略 showInFolder：缺少 path");
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{path}\"",
                UseShellExecute = true,
            });
            DebugLog.Write($"showInFolder path={path}");
        }
        catch (Exception exception)
        {
            // UI 边界：explorer 启动失败（路径含非法字符/被策略阻止）只记日志。
            DebugLog.Write($"showInFolder 失败 path={path}：{exception.Message}");
        }
    }

    private void SavePosition(InboundMessage message)
    {
        if (_currentDocument is not { } document)
        {
            DebugLog.Write("忽略 savePosition：当前没有打开的文档");
            return;
        }

        if (string.IsNullOrWhiteSpace(message.Key))
        {
            DebugLog.Write("忽略 savePosition：缺少 key");
            return;
        }

        _store.SavePosition(message.Key, document.Path, message.Ratio, DateTimeOffset.UtcNow);
        DebugLog.Write($"savePosition key={message.Key} ratio={message.Ratio:0.###}");
    }

    private void Post(string messageJson)
    {
        var core = WebView.CoreWebView2;
        if (core is null)
        {
            DebugLog.Write("WebView2 未就绪，丢弃消息：" + Truncate(messageJson, 160));
            return;
        }

        try
        {
            core.PostWebMessageAsJson(messageJson);
        }
        catch (Exception exception)
        {
            // UI 边界：WebView2 正在关闭/已释放时可能抛 COMException，推送失败只记日志。
            DebugLog.Write($"推送消息失败：{exception.Message}");
        }
    }

    /// <summary>
    /// 组装页面 HTML：读嵌入资源 index.html + md-engine.js，把引擎内联进占位 script 后交给 NavigateToString。
    /// </summary>
    private static string BuildPageHtml()
    {
        var assembly = typeof(MainWindow).Assembly;
        var indexHtml = ReadEmbeddedResource(assembly, ".index.html");
        var engineJs = ReadEmbeddedResource(assembly, ".md-engine.js");

        // HTML 解析先于 JS：bundle 里只要出现字面 </script 就会提前结束脚本元素。
        // 替换成 <\/script —— 在 JS 字符串/模板/正则里 \/ 等价于 /，语义不变。
        var safeEngineJs = Regex.Replace(engineJs, "</script", "<\\/script", RegexOptions.IgnoreCase);
        var engineTag = "<script id=\"md-engine\">" + safeEngineJs + "</script>";

        if (indexHtml.Contains(EnginePlaceholder, StringComparison.Ordinal))
        {
            return indexHtml.Replace(EnginePlaceholder, engineTag, StringComparison.Ordinal);
        }

        // 占位符被改动时兜底：插到 </body> 前，至少保证引擎会执行（否则 shellReady 永远不会来）。
        var bodyEnd = indexHtml.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return bodyEnd >= 0 ? indexHtml.Insert(bodyEnd, engineTag) : indexHtml + engineTag;
    }

    private static string ReadEmbeddedResource(Assembly assembly, string nameSuffix)
    {
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith(nameSuffix, StringComparison.OrdinalIgnoreCase));
        if (resourceName is null)
        {
            throw new InvalidOperationException($"嵌入资源缺失：*{nameSuffix}");
        }

        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"无法读取嵌入资源：{resourceName}");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static bool HasExtendedPathPrefix(string path)
        => path.StartsWith(@"\\?\", StringComparison.Ordinal)
            || path.StartsWith(@"\\.\", StringComparison.Ordinal);

    private static string RemoveExtendedPathPrefix(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.Ordinal))
        {
            return @"\\" + path[8..];
        }

        return HasExtendedPathPrefix(path) ? path[4..] : path;
    }

    private static string Truncate(string text, int maxLength)
        => text.Length <= maxLength ? text : text[..maxLength] + "…";
}
