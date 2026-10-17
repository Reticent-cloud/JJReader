using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
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

    private readonly Store _store;
    private readonly string _webViewDataFolder;

    private Task? _webViewInitialization;
    private bool _shellReady;
    private bool _virtualHostMapped;

    /// <summary>下一次 NavigationStarting 是初始 NavigateToString 装载（C2：只放行这一次整页导航）。</summary>
    private bool _initialNavigationPending;
    private string? _pendingDocumentPath;
    private DocumentRead? _currentDocument;

    /// <summary>关于面板（Task 16）：模态打开，字段防重复创建。</summary>
    private AboutWindow? _aboutWindow;

    /// <summary>pickFolder 选中的文件夹：文件树浏览根（Task 14），同时用作下次对话框的初始目录。</summary>
    private string? _browseRoot;

    /// <summary>前端完成一次渲染（来自 <c>renderDone</c> 消息；--verify-render 与 debug 日志使用）。</summary>
    public event Action<InboundMessage>? RenderDone;

    /// <summary>savePosition 日志折叠（M2）：同一文档只记一次，避免每 500ms 一行刷爆 debug.log。</summary>
    private string? _lastPositionLogKey;

    /// <summary>WebView2 启动失败时只弹一次原生对话框（重试/重载不再重复打扰）。</summary>
    private bool _webViewFailureShown;

    /// <summary>
    /// 离屏自检窗口（--verify-render / --verify-pdf）不写回窗口几何：它们把窗口放到 -32000，
    /// 若照常保存会覆盖用户真实的窗口位置/大小。由 VerifyRender/VerifyPdf 在 Show 前设置。
    /// </summary>
    internal bool SuppressGeometryPersistence { get; set; }

    /// <summary>
    /// 离屏自检窗口不弹 WebView2 失败模态框：命令行自检缺运行时必须快速失败/退出，
    /// 不能被一个需要人点的对话框挂住（仍显示 WPF 解释页并写日志）。
    /// </summary>
    internal bool SuppressFailureDialog { get; set; }

    public MainWindow()
    {
        InitializeComponent();

        // 数据目录统一由 AppPaths 计算（只给路径，Store 落盘时自行创建）；WebView2 缓存默认仍在
        // %LOCALAPPDATA%\JingjingReader\WebView2，验收隔离时随 JJ_DATA_DIR 一起改到临时目录。
        _store = new Store(AppPaths.DataDir);
        _webViewDataFolder = AppPaths.WebViewDataDir;

        // I1（spec §5.1）：启动时恢复窗口几何；关闭时把位置/大小/最大化写回 settings.json。
        ApplySavedWindowGeometry();
        Closing += OnWindowClosing;
        Loaded += OnLoaded;
    }

    /// <summary>
    /// I1：把 settings.Window 夹紧到虚拟屏幕工作区后应用。WindowStartupLocation=Manual
    /// （XAML 默认按位置手动）避免 WPF 再把窗口挪到主屏中央。
    /// 读取失败只记日志：窗口几何是锦上添花，不能阻断启动。
    /// </summary>
    private void ApplySavedWindowGeometry()
    {
        try
        {
            var saved = _store.LoadSettings().Window;
            if (saved is null)
            {
                return;
            }

            WindowStartupLocation = WindowStartupLocation.Manual;
            var workArea = ResolveWorkArea(saved);
            var clamped = WindowGeometryClamp.Clamp(saved, workArea);
            Left = clamped.X;
            Top = clamped.Y;
            Width = clamped.W;
            Height = clamped.H;
            if (clamped.Max)
            {
                WindowState = WindowState.Maximized;
            }

            DebugLog.Write(
                $"恢复窗口几何 saved=({saved.X},{saved.Y},{saved.W},{saved.H},max={saved.Max}) " +
                $"workArea=({workArea.X},{workArea.Y},{workArea.Width},{workArea.Height}) " +
                $"applied=({clamped.X},{clamped.Y},{clamped.W},{clamped.H})");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"恢复窗口几何失败：{exception}");
        }
    }

    /// <summary>
    /// I1：取几何所在屏幕的工作区。必须使用 WPF 的 DIP 口径（<see cref="SystemParameters.WorkArea"/> /
    /// 虚拟屏幕），不能把 Win32 GetMonitorInfo 的物理像素与 <see cref="Window.Left"/>（DIP）混用——
    /// 200% DPI 下会把窗口"夹紧"到屏幕外的双倍坐标。
    /// 保存位置与主屏工作区有交集 → 用主屏工作区（排除任务栏）；在副屏/完全出屏 → 用虚拟屏幕范围（近似工作区）。
    /// </summary>
    private static Rect ResolveWorkArea(WindowGeometry geometry)
    {
        var saved = new Rect(
            geometry.X,
            geometry.Y,
            Math.Max(geometry.W, 1),
            Math.Max(geometry.H, 1));
        var primaryWorkArea = SystemParameters.WorkArea;
        if (saved.IntersectsWith(primaryWorkArea))
        {
            return primaryWorkArea;
        }

        var virtualScreen = new Rect(
            SystemParameters.VirtualScreenLeft,
            SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth,
            SystemParameters.VirtualScreenHeight);
        var multiMonitor = virtualScreen.Width > primaryWorkArea.Width + 1
            || virtualScreen.Height > primaryWorkArea.Height + 1
            || Math.Abs(virtualScreen.Left - primaryWorkArea.Left) > 1
            || Math.Abs(virtualScreen.Top - primaryWorkArea.Top) > 1;
        return multiMonitor ? virtualScreen : primaryWorkArea;
    }

    /// <summary>
    /// I1：关闭时写回窗口几何。最大化时保存 <see cref="Window.RestoreBounds"/>（还原后的正常尺寸），
    /// 下次启动最大化且还原尺寸正确；写盘失败只记日志。
    /// </summary>
    private void OnWindowClosing(object? sender, CancelEventArgs e)
    {
        if (SuppressGeometryPersistence)
        {
            return;
        }

        try
        {
            var bounds = RestoreBounds;
            if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0)
            {
                bounds = new Rect(Left, Top, Math.Max(Width, WindowGeometryClamp.MinWidth), Math.Max(Height, WindowGeometryClamp.MinHeight));
            }

            var geometry = new WindowGeometry(
                (int)Math.Round(bounds.X),
                (int)Math.Round(bounds.Y),
                (int)Math.Round(bounds.Width),
                (int)Math.Round(bounds.Height),
                WindowState == WindowState.Maximized);
            var settings = _store.LoadSettings();
            _store.SaveSettings(settings with { Window = geometry });
            DebugLog.Write(
                $"保存窗口几何 ({geometry.X},{geometry.Y},{geometry.W},{geometry.H},max={geometry.Max})");
        }
        catch (Exception exception)
        {
            // 退出路径：写盘失败只记日志，绝不能阻止窗口关闭（spec §6.2）
            DebugLog.Write($"保存窗口几何失败：{exception}");
        }
    }

    /// <summary>
    /// I1：在首次点击前把窗口带到前台（单实例转交入口）：最小化 → 还原，然后 Show/Activate。
    /// 放在 MainWindow 上便于 App 的 IPC 回调与正常启动共用一段逻辑（也便于手测）。
    /// </summary>
    public void BringToForeground()
    {
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }

        Show();
        Activate();
        Focus();
    }

    /// <summary>
    /// I4：全局异常兜底的可恢复错误提示（仅 UI 线程异常使用；只弹一次，避免异常风暴刷屏）。
    /// 宿主已把完整异常写进 debug.log，这里只给用户一个不打断阅读的 toast。
    /// </summary>
    public void ShowRecoverableError(string text)
    {
        try
        {
            Post(Protocol.Toast(text, "error"));
        }
        catch (Exception exception)
        {
            DebugLog.Write($"显示异常提示失败：{exception.Message}");
        }
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
            // 窗口初始化是 UI 顶层边界：WebView2 运行时缺失/初始化失败时记录并弹原生对话框，
            // 不让异常冒泡成未处理异常（I3 / spec §5.11）。
            DebugLog.Write($"WebView2 初始化失败：{exception}");
            ConsoleHelper.WriteLine($"ERROR WebView2 初始化失败：{exception.Message}");
            ShowWebView2StartupFailure(exception);
            if (SuppressFailureDialog)
            {
                // 命令行自检：WebView2 无法初始化时没有可等待的 renderDone，直接以退出码 2 失败。
                Application.Current?.Shutdown(2);
            }
        }
    }

    private Task EnsureWebViewInitializedAsync() => _webViewInitialization ??= InitializeWebViewAsync();

    /// <summary>
    /// I3（spec §5.11）：WebView2 缺失/初始化失败 → 原生对话框（说明 + 下载运行时 + 打开数据目录）；
    /// 关闭后显示 WPF 解释页并保持窗口可用（缺运行时连 NavigateToString 都无法渲染，所以用 WPF 控件承载说明）。
    /// 只弹一次：重试/重载失败不重复打扰。
    /// </summary>
    private void ShowWebView2StartupFailure(Exception exception)
    {
        if (_webViewFailureShown)
        {
            return;
        }

        _webViewFailureShown = true;
        var model = WebView2StartupFailure.BuildDialogModel(exception);
        if (SuppressFailureDialog)
        {
            // 命令行自检：只显示解释页（不阻塞）。
            ShowWebView2ExplanationPage(model);
            return;
        }

        try
        {
            var dialog = new Window
            {
                Title = model.Title,
                Owner = this,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                SizeToContent = SizeToContent.Height,
                Width = 560,
                Background = SystemColors.WindowBrush,
            };

            var panel = new StackPanel { Margin = new Thickness(20) };
            panel.Children.Add(new TextBlock
            {
                Text = model.Summary,
                TextWrapping = TextWrapping.Wrap,
                FontSize = 14,
                Margin = new Thickness(0, 0, 0, 12),
            });
            panel.Children.Add(new TextBlock
            {
                Text = model.Detail,
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                Foreground = SystemColors.GrayTextBrush,
                Margin = new Thickness(0, 0, 0, 16),
            });

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
            };
            var download = new Button { Content = model.DownloadButtonText, Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 0, 8, 0) };
            download.Click += (_, _) => TryOpenExternal(model.DownloadUrl);
            var openDataDir = new Button { Content = model.OpenDataDirButtonText, Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 0, 8, 0) };
            openDataDir.Click += (_, _) => TryOpenDirectory(model.DataDir);
            var close = new Button { Content = model.CloseButtonText, Padding = new Thickness(12, 4, 12, 4), IsDefault = true, IsCancel = true };
            close.Click += (_, _) => dialog.Close();
            buttons.Children.Add(download);
            buttons.Children.Add(openDataDir);
            buttons.Children.Add(close);
            panel.Children.Add(buttons);
            dialog.Content = panel;
            dialog.ShowDialog();
        }
        catch (Exception dialogError)
        {
            // 连对话框都建不出来时退回最简消息框：说明书必须让用户看到
            DebugLog.Write($"显示 WebView2 失败对话框失败：{dialogError}");
            MessageBox.Show(this, model.Summary + Environment.NewLine + model.DownloadUrl, model.Title);
        }

        ShowWebView2ExplanationPage(model);
    }

    /// <summary>I3：关闭对话框后的解释页（WebView2 不可用时用 WPF 控件承载，窗口继续可用）。</summary>
    private void ShowWebView2ExplanationPage(WebView2FailureDialog model)
    {
        try
        {
            WebView.Visibility = Visibility.Collapsed;
            if (Content is not Panel root)
            {
                return;
            }

            var box = new Border
            {
                Margin = new Thickness(32),
                Padding = new Thickness(28),
                Background = SystemColors.WindowBrush,
            };
            var panel = new StackPanel
            {
                MaxWidth = 640,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            panel.Children.Add(new TextBlock
            {
                Text = model.Title,
                FontSize = 22,
                FontWeight = FontWeights.SemiBold,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 12),
            });
            panel.Children.Add(new TextBlock
            {
                Text = model.Summary,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 8),
            });
            panel.Children.Add(new TextBlock
            {
                Text = model.RuntimeMissing
                    ? $"安装完成后重新启动本程序。数据目录：{model.DataDir}"
                    : $"可尝试重新启动；若仍失败，请安装/修复 WebView2 Runtime。数据目录：{model.DataDir}",
                TextWrapping = TextWrapping.Wrap,
                Foreground = SystemColors.GrayTextBrush,
                FontSize = 13,
            });
            box.Child = panel;
            root.Children.Add(box);
            Title = "无法启动 — 鲸鲸阅读器";
        }
        catch (Exception exception)
        {
            DebugLog.Write($"显示 WebView2 解释页失败：{exception}");
        }
    }

    /// <summary>打开 http(s) 地址（WebView2 失败对话框的下载按钮；失败只记日志）。</summary>
    private static void TryOpenExternal(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            DebugLog.Write($"打开下载页失败 url={url}：{exception.Message}");
        }
    }

    /// <summary>在资源管理器打开目录（失败只记日志；目录不存在时先创建）。</summary>
    private static void TryOpenDirectory(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{directory}\"") { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            DebugLog.Write($"打开目录失败 path={directory}：{exception.Message}");
        }
    }

    private async Task InitializeWebViewAsync()
    {
        // userDataFolder 默认 %LOCALAPPDATA%\JingjingReader\WebView2；设置 JJ_DATA_DIR 时随数据目录隔离
        // （修复波 B-I2 验收隔离，目录不存在则创建）。
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
        // NavigateToString 页没有可恢复的历史/内容：Reload/Back 等默认右键菜单项只会把页面弄坏。
        settings.AreDefaultContextMenusEnabled = false;

        core.WebMessageReceived += OnWebMessageReceived;
        // Task 13：应用内不开第二个 WebView；http(s) 外链交给系统默认浏览器，其它协议忽略。
        core.NewWindowRequested += OnNewWindowRequested;
        // C2：.md 内容可带任意链接；除初始装载与同文档 #fragment 外，WebView 内导航一律拦截。
        core.NavigationStarting += OnNavigationStarting;
        _initialNavigationPending = true;
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

        // M11：大文件同步 ReadAllBytes 会卡住 UI 线程；50 MB 以上直接拒绝（不做异步化改造）。
        try
        {
            var size = new FileInfo(normalizedPath).Length;
            if (FileHost.IsTooLarge(size))
            {
                DebugLog.Write($"拒绝打开过大文件 path={normalizedPath} size={size}");
                Post(Protocol.Toast("文件过大，暂不支持打开（>50MB）", "warn"));
                return;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // 文件不存在/无权限：交给下面的 ReadDocument 统一报错（保持原有提示与标题行为）。
            DebugLog.Write($"读取文件大小失败 path={normalizedPath}：{exception.Message}");
        }

        DocumentRead document;
        try
        {
            document = FileHost.ReadDocument(normalizedPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // 文件不存在/无权限/路径非法：保持窗口可用；toast 之外再发持久 notice，
            // 前端显示可关闭的顶部错误条（spec §5.11「错误条（持续显示，可关闭）」）。
            DebugLog.Write($"打开文档失败 path={normalizedPath} error={exception}");
            Title = $"{Path.GetFileName(normalizedPath)} — 鲸鲸阅读器";
            Post(Protocol.Toast($"无法打开文件：{Path.GetFileName(normalizedPath)}", "error"));
            Post(Protocol.Notice(
                $"无法打开文件：{Path.GetFileName(normalizedPath)}（{exception.Message}）",
                "error",
                persistent: true));
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
            $"size={document.Size} binary={isBinary} hadReplacement={document.HadReplacement}");

        // 二进制文件不渲染正文：给前端空 markdown + toast 拒绝提示（DocumentRead 以 encoding=binary 为信号）。
        // 修复波 B-§5.11：load 附带 encoding 供前端调试；持久 notice 进错误条（比 3 秒 toast 更容易看到）。
        Post(Protocol.Load(
            document.Path,
            document.Key,
            FileHost.VirtualHostUrl(document.Path, relativeOrAbsolutePath: null),
            isBinary ? string.Empty : document.Text,
            settings,
            position,
            document.EncodingName));

        if (isBinary)
        {
            Post(Protocol.Toast("该文件不是文本文件，已拒绝渲染", "warn"));
            Post(Protocol.Notice("该文件不是文本文件，已拒绝渲染", "warn", persistent: true));
        }
        else if (document.HadReplacement)
        {
            // §5.11 编码异常：尽力显示 + 提示条「文件编码可能不是 UTF-8，部分字符已替换」
            Post(Protocol.Notice("文件编码可能不是 UTF-8，部分字符已替换", "warn", persistent: true));
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
    /// Task 16：把当前 .md 关联状态推给前端（关于按钮 title 与后续提示用）。
    /// 注册表读取失败只记日志：关联状态不能影响 shell 握手与正文推送。
    /// </summary>
    private void PostAssocState()
    {
        try
        {
            var state = Assoc.GetState(new Win32AssocRegistry());
            Post(Protocol.AssocState(state.Registered, state.IsDefault));
            DebugLog.Write($"assocState registered={state.Registered} isDefault={state.IsDefault}");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"读取 .md 关联状态失败：{exception.Message}");
        }
    }

    /// <summary>Task 16：打开关于面板（模态、居中于主窗口；同一时刻只允许一个）。</summary>
    private void ShowAbout()
    {
        if (_aboutWindow is not null)
        {
            _aboutWindow.Activate();
            return;
        }

        var window = new AboutWindow { Owner = this };
        _aboutWindow = window;
        try
        {
            window.ShowDialog();
        }
        finally
        {
            _aboutWindow = null;
        }
    }

    /// <summary>
    /// 修复波 B-前端空白启动：把持久化偏好推给前端（消息 <c>settings</c>；payload 是 AppSettings 字段）。
    /// 读设置失败只记日志：偏好不能影响 shell 握手与正文推送。
    /// </summary>
    private void PostSettings()
    {
        try
        {
            Post(Protocol.Settings(_store.LoadSettings()));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            DebugLog.Write($"读取设置失败：{exception.Message}");
        }
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
        // C2：只接受应用文档（about:blank）的消息；远程页面/未知来源即使拿到 WebView2 也不能驱动宿主。
        if (!WebViewSecurityPolicy.IsTrustedMessageSource(e.Source))
        {
            DebugLog.Write($"忽略来源不可信的前端消息 source={e.Source}");
            return;
        }

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
                // 修复波 B-前端空白启动：空白页也应用持久偏好（主题/字号/行宽），不必等 load。
                PostSettings();
                // Task 16：把 .md 关联状态推给前端（工具条「关于」按钮 title）。
                PostAssocState();
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

            case "openRecent":
                OpenRecent(message.Path);
                break;

            case "openTreeFile":
                OpenTreeFile(message.Path);
                break;

            case "openDefaultApps":
                OpenDefaultApps();
                break;

            case "pickFile":
                PickFile();
                break;

            case "pickFolder":
                PickFolder();
                break;

            case "listDir":
                TryPostDirectoryListing(message.Path);
                break;

            case "reload":
                ReloadCurrentDocument();
                break;

            case "showInFolder":
                ShowInFolder(message.Path);
                break;

            case "exportPdf":
                ExportPdf(message.SuggestedName);
                break;

            case "readyToPrint":
                // 前端已进入打印模式（浅色 + 隐藏界面 chrome）：唤醒等待中的 PdfExport。
                PdfExport.NotifyReadyToPrint();
                break;

            case "openAbout":
                // Task 16：工具条「关于」入口。
                ShowAbout();
                break;

            default:
                // 其余契约消息（当前没有）只记日志。
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
    /// openFile（C1）：只接受文档目录内的**相对路径**（wikilink / 附件）。绝对路径、UNC、盘符相对
    /// 与带 <c>..</c> 的路径一律拒绝并 toast，避免 .md 内容让宿主读取任意本地文件或触发 UNC 认证。
    /// 解析走 <see cref="OpenTargetResolver"/>：精确路径 → 无扩展名补 .md → 大小写不敏感/递归子目录。
    /// 最近文件与文件树分别走 <see cref="OpenRecent"/>/<see cref="OpenTreeFile"/>，不再共用绝对路径入口。
    /// </summary>
    private void OpenFile(string? relPath)
    {
        if (string.IsNullOrWhiteSpace(relPath))
        {
            DebugLog.Write("忽略 openFile：缺少 relPath");
            Post(Protocol.Toast("无法打开文件：缺少路径", "error"));
            return;
        }

        if (!OpenPathPolicy.IsContentTargetAllowed(relPath))
        {
            DebugLog.Write($"拒绝 openFile 非相对路径 relPath={relPath}");
            Post(Protocol.Toast("不支持打开该路径", "error"));
            return;
        }

        string? target = null;
        try
        {
            if (_currentDocument is { } document)
            {
                var directory = Path.GetDirectoryName(document.Path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    target = OpenTargetResolver.Resolve(directory, relPath);
                }
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            DebugLog.Write($"openFile 路径非法 relPath={relPath}：{exception.Message}");
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            DebugLog.Write($"openFile 未找到 relPath={relPath}");
            Post(Protocol.Toast($"未找到「{relPath}」", "warn"));
            return;
        }

        OpenDocument(target);
    }

    /// <summary>
    /// openRecent（C1）：只打开 recent.json 里归一化后命中的路径。前端最近面板/菜单/Alt+←→
    /// 传来的绝对路径即使被篡改，也无法打开列表之外的任意文件。
    /// </summary>
    private void OpenRecent(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            DebugLog.Write("忽略 openRecent：缺少 path");
            Post(Protocol.Toast("无法打开文件：缺少路径", "error"));
            return;
        }

        string normalized;
        try
        {
            normalized = FileHost.NormalizePath(path);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            DebugLog.Write($"拒绝 openRecent 非法路径 path={path}：{exception.Message}");
            Post(Protocol.Toast("不支持打开该路径", "error"));
            return;
        }

        if (!OpenPathPolicy.IsRecentPath(normalized, _store.LoadRecent()))
        {
            DebugLog.Write($"拒绝 openRecent 不在最近列表 path={normalized}");
            Post(Protocol.Toast("不支持打开该路径", "error"));
            return;
        }

        OpenDocument(normalized);
    }

    /// <summary>
    /// openTreeFile（C1）：只打开浏览根内、扩展名为 Markdown/文本的文件。
    /// 前端传来的绝对路径先经归一化包含性校验，越界/未选根/类型不符一律拒绝。
    /// </summary>
    private void OpenTreeFile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(_browseRoot))
        {
            DebugLog.Write($"拒绝 openTreeFile：缺少路径或尚未打开文件夹 path={path}");
            Post(Protocol.Toast("不支持打开该路径", "error"));
            return;
        }

        var target = FileHost.ResolveInside(_browseRoot, path);
        if (target is null || !FileHost.IsMarkdown(target))
        {
            DebugLog.Write($"拒绝 openTreeFile 越界或类型不支持 root={_browseRoot} path={path}");
            Post(Protocol.Toast("不支持打开该路径", "error"));
            return;
        }

        OpenDocument(target);
    }

    /// <summary>M6：打开系统「默认应用」设置页（openDefaultApps 落地，不再静默忽略）。</summary>
    private void OpenDefaultApps()
    {
        try
        {
            Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
            DebugLog.Write("打开系统默认应用设置");
        }
        catch (Exception exception)
        {
            // UI 边界：系统设置协议被策略拦截/无 shell 时只记日志并提示
            DebugLog.Write($"打开系统默认应用设置失败：{exception.Message}");
            Post(Protocol.Toast("无法打开默认应用设置", "error"));
        }
    }

    /// <summary>pickFile：系统打开对话框（Markdown/所有文件），选中后走 <see cref="OpenDocument"/>；取消不做任何事。</summary>
    private void PickFile()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "打开 Markdown 文件",
            Filter = "Markdown 文件|*.md;*.markdown;*.mdown;*.txt|所有文件|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (PreferredBrowseDirectory() is { } directory)
        {
            dialog.InitialDirectory = directory;
        }

        if (dialog.ShowDialog(this) != true)
        {
            DebugLog.Write("pickFile 已取消");
            return;
        }

        DebugLog.Write($"pickFile path={dialog.FileName}");
        OpenDocument(dialog.FileName);
    }

    /// <summary>
    /// pickFolder：系统文件夹对话框（.NET 8+ 的 OpenFolderDialog），选中后进入文件树浏览；
    /// 记下的目录同时作为后续对话框的初始位置。
    /// </summary>
    private void PickFolder()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "选择文件夹",
            Multiselect = false,
        };
        if (PreferredBrowseDirectory() is { } directory)
        {
            dialog.InitialDirectory = directory;
        }

        if (dialog.ShowDialog(this) != true)
        {
            DebugLog.Write("pickFolder 已取消");
            return;
        }

        DebugLog.Write($"pickFolder path={dialog.FolderName}");
        OpenFolder(dialog.FolderName);
    }

    /// <summary>
    /// 打开文件夹浏览（pickFolder 与拖入文件夹共用）：先列根目录、成功后才提交新浏览根，再推根 dirListing 并提示。
    /// 列目录失败时保留原浏览根（评审 Minor 1：不能先换根再失败，让宿主根与前端树错位）。
    /// </summary>
    private void OpenFolder(string folderPath)
    {
        string root;
        try
        {
            root = FileHost.NormalizePath(folderPath);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            DebugLog.Write($"打开文件夹失败 path={folderPath}：{exception.Message}");
            Post(Protocol.Toast("无法打开文件夹", "error"));
            return;
        }

        if (!Directory.Exists(root))
        {
            DebugLog.Write($"打开文件夹失败（目录不存在） path={root}");
            Post(Protocol.Toast("无法打开文件夹", "error"));
            return;
        }

        // 先列目录：失败时保留旧根（前端树仍指向旧根，宿主根不能先换掉）。
        IReadOnlyList<(string Name, bool IsDir, string RelPath)> entries;
        try
        {
            entries = DirectoryLister.List(root, string.Empty);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            DebugLog.Write($"打开文件夹失败（无法读取目录） root={root}：{exception.Message}");
            Post(Protocol.Toast("无法读取该目录", "warn"));
            return;
        }

        // 列目录成功才提交新根并推送根列表（宿主 pickFolder 后先推根列表再 toast）。
        _browseRoot = root;
        DebugLog.Write($"打开文件夹 root={_browseRoot}");
        Post(Protocol.DirListing(root, string.Empty, entries));
        Post(Protocol.Toast($"已打开文件夹：{FolderName(root)}"));
    }

    /// <summary>
    /// 列出浏览根下 <paramref name="relativePath"/>（空串 = 根）并推 <c>dirListing{root,path,entries}</c>。
    /// 尚未选择文件夹时提示；越界/无权限/目录不存在时 toast「无法读取该目录」。
    /// </summary>
    private bool TryPostDirectoryListing(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(_browseRoot))
        {
            DebugLog.Write("忽略 listDir：尚未打开文件夹");
            Post(Protocol.Toast("请先打开文件夹", "warn"));
            return false;
        }

        var relative = (relativePath ?? string.Empty).Trim();
        try
        {
            var entries = DirectoryLister.List(_browseRoot, relative);
            Post(Protocol.DirListing(_browseRoot, relative, entries));
            DebugLog.Write($"dirListing root={_browseRoot} path={relative} entries={entries.Count}");
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            DebugLog.Write($"读取目录失败 root={_browseRoot} path={relative}：{exception.Message}");
            Post(Protocol.Toast("无法读取该目录", "warn"));
            return false;
        }
    }

    /// <summary>浏览根的显示名（盘符根等取不到名称时回退完整路径）。</summary>
    private static string FolderName(string path)
    {
        var trimmed = path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var name = Path.GetFileName(trimmed);
        return string.IsNullOrEmpty(name) ? path : name;
    }

    /// <summary>对话框初始目录：当前文档所在目录优先，其次上次 pickFolder 的选择。</summary>
    private string? PreferredBrowseDirectory()
    {
        if (_currentDocument is { } document)
        {
            var directory = Path.GetDirectoryName(document.Path);
            if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory))
            {
                return directory;
            }
        }

        return _browseRoot is { Length: > 0 } root && Directory.Exists(root) ? root : null;
    }

    /// <summary>拖入文件：接受 FileDrop（Effects=Copy），其余拖拽类型不接管。</summary>
    private void OnDragOver(object sender, DragEventArgs e)
    {
        var isFileDrop = e.Data.GetDataPresent(DataFormats.FileDrop);
        e.Effects = isFileDrop ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    /// <summary>
    /// 拖放打开：取第一个路径。Markdown 文件直接打开；文件夹进入文件树浏览（Task 14）；
    /// 其它类型提示不支持。所有异常只记日志，拖放不能把宿主带崩。
    /// </summary>
    private void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            return;
        }

        e.Handled = true;

        string? first = null;
        try
        {
            if (e.Data.GetData(DataFormats.FileDrop) is string[] paths)
            {
                first = paths.FirstOrDefault(path => !string.IsNullOrWhiteSpace(path));
            }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"读取拖放数据失败：{exception.Message}");
            return;
        }

        if (first is null)
        {
            return;
        }

        try
        {
            if (Directory.Exists(first))
            {
                OpenFolder(first);
                return;
            }

            if (File.Exists(first) && FileHost.IsMarkdown(first))
            {
                OpenDocument(first);
                return;
            }

            DebugLog.Write($"拖放不支持的文件 path={first}");
            Post(Protocol.Toast("不支持的文件类型", "warn"));
        }
        catch (Exception exception)
        {
            // UI 事件边界：路径解析/文件系统异常只记日志
            DebugLog.Write($"拖放打开失败 path={first}：{exception}");
        }
    }

    /// <summary>
    /// C2：WebView 内导航守卫。只放行初始 NavigateToString 与同文档 #fragment；
    /// 其余导航取消，http(s) 改交系统默认浏览器（远程页不能在本 WebView 里继承 chrome.webview）。
    /// </summary>
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var isInitial = _initialNavigationPending;
        if (isInitial)
        {
            _initialNavigationPending = false;
        }

        var current = WebView.CoreWebView2?.Source;
        if (WebViewSecurityPolicy.IsAllowedNavigation(e.Uri, current, isInitial))
        {
            return;
        }

        e.Cancel = true;
        DebugLog.Write($"已拦截 WebView 内导航：{e.Uri}");

        if (WebViewSecurityPolicy.TryGetHttpUri(e.Uri, out var uri) && uri is not null)
        {
            OpenExternalUri(uri);
        }
    }

    /// <summary>
    /// 新窗口请求（target=_blank 外链，Task 6 carry-forward）：取消应用内新窗口；
    /// http(s) 交给系统默认浏览器，其它协议（file/javascript 等）忽略。
    /// </summary>
    private static void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!WebViewSecurityPolicy.TryGetHttpUri(e.Uri, out var uri) || uri is null)
        {
            DebugLog.Write($"忽略非 http(s) 新窗口请求：{e.Uri}");
            return;
        }

        OpenExternalUri(uri);
    }

    /// <summary>http(s) 外链交给系统默认浏览器；启动失败只记日志。</summary>
    private static void OpenExternalUri(Uri uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            DebugLog.Write($"外链交给系统浏览器：{uri.AbsoluteUri}");
        }
        catch (Exception exception)
        {
            // UI 边界：系统没有默认浏览器/被策略阻止时只记日志
            DebugLog.Write($"打开外链失败 uri={uri.AbsoluteUri}：{exception.Message}");
        }
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

    /// <summary>
    /// exportPdf（Task 15）：系统保存对话框（默认 <c>&lt;文档名&gt;.pdf</c>，可用前端 suggestedName）→
    /// 交给 <see cref="PdfExport"/> 异步导出。取消对话框什么都不做。
    /// </summary>
    private void ExportPdf(string? suggestedName)
    {
        if (_currentDocument is not { } document)
        {
            DebugLog.Write("忽略 exportPdf：当前没有打开的文档");
            Post(Protocol.Toast("请先打开文档", "warn"));
            return;
        }

        var core = WebView.CoreWebView2;
        if (core is null)
        {
            DebugLog.Write("忽略 exportPdf：WebView2 未就绪");
            Post(Protocol.Toast("导出 PDF 失败：WebView2 未就绪", "error"));
            return;
        }

        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "导出 PDF",
            Filter = "PDF 文件|*.pdf",
            DefaultExt = ".pdf",
            AddExtension = true,
            OverwritePrompt = true,
            FileName = DefaultPdfFileName(suggestedName, document.Path),
        };
        if (PreferredBrowseDirectory() is { } directory)
        {
            dialog.InitialDirectory = directory;
        }

        if (dialog.ShowDialog(this) != true)
        {
            DebugLog.Write("exportPdf 已取消");
            return;
        }

        var outputPath = dialog.FileName;
        DebugLog.Write($"exportPdf path={outputPath}");
        _ = RunPdfExportAsync(core, outputPath);
    }

    /// <summary>执行导出并按结果 toast：成功提示完整路径并用资源管理器定位；失败删除半成品并提示错误。</summary>
    private async Task RunPdfExportAsync(Microsoft.Web.WebView2.Core.CoreWebView2 core, string outputPath)
    {
        // 覆盖已有文件时，先记下原文件状态：导出失败且文件没被本次写入改动就保留用户原文件。
        var existsBefore = false;
        var writeTimeBefore = default(DateTime);
        try
        {
            var before = new FileInfo(outputPath);
            existsBefore = before.Exists;
            if (existsBefore)
            {
                writeTimeBefore = before.LastWriteTimeUtc;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            DebugLog.Write($"exportPdf 读取目标文件状态失败 path={outputPath}：{exception.Message}");
        }

        var success = false;
        try
        {
            success = await PdfExport.ExportAsync(core, outputPath);
        }
        catch (Exception exception)
        {
            // PDF 导出是异步 UI 流程：任何异常都不能变成未处理异常
            DebugLog.Write($"exportPdf 异常 path={outputPath}：{exception}");
        }

        if (!success)
        {
            // M8：失败时删除半成品，避免用户下次看到一份损坏的 PDF 冒充导出结果；
            // 若目标文件是导出前就有且本次没被改写（例如进入打印模式就失败），保留用户原文件。
            DeletePartialPdf(outputPath, existsBefore, writeTimeBefore);
            Post(Protocol.Toast("导出 PDF 失败", "error"));
            return;
        }

        // M8：成功提示完整路径（同名文件在不同目录时用户能确认落盘位置）。
        Post(Protocol.Toast("已导出 PDF：" + outputPath));
        ShowInFolder(outputPath);
    }

    /// <summary>
    /// 删除导出失败留下的半成品；文件不存在/被占用只记日志，绝不抛异常。
    /// 导出前已存在且最后一次写入时间未变时视为「本次没写」，保留原文件。
    /// </summary>
    internal static void DeletePartialPdf(string path, bool existsBefore, DateTime writeTimeBefore)
    {
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists)
            {
                return;
            }

            if (existsBefore && file.LastWriteTimeUtc == writeTimeBefore)
            {
                DebugLog.Write($"exportPdf 失败但目标文件未被改写，保留原文件 path={path}");
                return;
            }

            file.Delete();
            DebugLog.Write($"exportPdf 已清理半成品 path={path}");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"exportPdf 清理半成品失败 path={path}：{exception.Message}");
        }
    }

    /// <summary>
    /// 保存对话框的默认文件名：前端 suggestedName 只取文件名部分并补 .pdf；
    /// 缺省时用当前文档名去扩展名 + .pdf；清理 Windows 非法文件名字符。
    /// </summary>
    private static string DefaultPdfFileName(string? suggestedName, string documentPath)
    {
        var raw = !string.IsNullOrWhiteSpace(suggestedName)
            ? Path.GetFileName(suggestedName.Trim())
            : Path.GetFileNameWithoutExtension(documentPath) + ".pdf";

        if (string.IsNullOrWhiteSpace(raw))
        {
            raw = "导出.pdf";
        }

        var sanitized = raw;
        foreach (var invalid in Path.GetInvalidFileNameChars())
        {
            sanitized = sanitized.Replace(invalid, '_');
        }

        if (sanitized.Length == 0)
        {
            sanitized = "导出";
        }

        return sanitized.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? sanitized : sanitized + ".pdf";
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

        // M3：切换文档时旧 key 的迟到 flush 不能把旧 key 写到新文档路径上。
        if (!IsCurrentDocumentKey(message.Key, document.Key))
        {
            DebugLog.Write($"忽略 savePosition：key 与当前文档不匹配 key={message.Key} current={document.Key}");
            return;
        }

        _store.SavePosition(message.Key, document.Path, message.Ratio, DateTimeOffset.UtcNow);

        // M2：savePosition 每 500ms 一条，逐条写日志会把 debug.log 刷爆（触发无意义的滚动）。
        // 同一文档的滚动上报只记首条（ratio 每次仍会持久化，只是不进日志）。
        if (!string.Equals(_lastPositionLogKey, document.Key, StringComparison.OrdinalIgnoreCase))
        {
            _lastPositionLogKey = document.Key;
            DebugLog.Write($"savePosition key={message.Key} ratio={message.Ratio:0.###}（后续同文档滚动不再逐条记录）");
        }
    }

    /// <summary>M3：位置消息的 key 是否就是当前文档的 key（大小写不敏感；空值不接受）。</summary>
    internal static bool IsCurrentDocumentKey(string? messageKey, string currentKey)
        => !string.IsNullOrWhiteSpace(messageKey)
            && string.Equals(messageKey, currentKey, StringComparison.OrdinalIgnoreCase);

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

        var engineTag = "<script id=\"md-engine\">" + EscapeScriptContent(engineJs) + "</script>";

        if (indexHtml.Contains(EnginePlaceholder, StringComparison.Ordinal))
        {
            return indexHtml.Replace(EnginePlaceholder, engineTag, StringComparison.Ordinal);
        }

        // 占位符被改动时兜底：插到 </body> 前，至少保证引擎会执行（否则 shellReady 永远不会来）。
        var bodyEnd = indexHtml.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return bodyEnd >= 0 ? indexHtml.Insert(bodyEnd, engineTag) : indexHtml + engineTag;
    }

    /// <summary>
    /// 把引擎源码里会提前结束/开启 HTML 解析的片段做等价转义（M10）：
    /// <c>&lt;/script</c> → <c>&lt;\/script</c>，<c>&lt;script</c> → <c>&lt;\script</c>，
    /// <c>&lt;!--</c> → <c>&lt;\!--</c>。三者在 JS 字符串/模板里语义不变（<c>\s</c>/<c>\!</c> 都是未识别转义），
    /// 但 HTML 解析器不会再把它们当成标签/注释，避免未来产物把页面提前截断成空白窗口。幂等：已转义的片段不会二次命中。
    /// </summary>
    internal static string EscapeScriptContent(string script)
    {
        ArgumentNullException.ThrowIfNull(script);

        var escaped = Regex.Replace(script, "<!--", "<\\!--");
        escaped = Regex.Replace(escaped, "<script", "<\\script", RegexOptions.IgnoreCase);
        return Regex.Replace(escaped, "</script", "<\\/script", RegexOptions.IgnoreCase);
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
