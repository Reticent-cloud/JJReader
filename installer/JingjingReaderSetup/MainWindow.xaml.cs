using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;

namespace JingjingReader.Setup;

/// <summary>安装器主窗口：选择目录/选项 → 安装进度 → 结果与后续操作。</summary>
public partial class MainWindow : Window
{
    private static readonly Brush SuccessBrush = new SolidColorBrush(Color.FromRgb(0x16, 0x79, 0x4C));
    private static readonly Brush ErrorBrush = new SolidColorBrush(Color.FromRgb(0xB4, 0x23, 0x18));

    private const uint MonitorDefaultToNearest = 2;

    private SetupResult? _result;
    private bool _installing;

    public MainWindow(SetupOptions startupOptions, string? runtimeWarning)
    {
        InitializeComponent();

        VersionText.Text = $"版本 {SetupLogic.ProductVersion} · 安装程序";
        InstallDirBox.Text = string.IsNullOrWhiteSpace(startupOptions.InstallDir)
            ? SetupLogic.GetDefaultInstallDir(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))
            : startupOptions.InstallDir;
        AssocCheck.IsChecked = startupOptions.CreateAssociation;
        DesktopCheck.IsChecked = startupOptions.CreateDesktopShortcut;

        if (!string.IsNullOrWhiteSpace(runtimeWarning))
        {
            RuntimeWarningText.Text = runtimeWarning;
            RuntimeWarningPanel.Visibility = Visibility.Visible;
        }
    }

    /// <summary>
    /// 按窗口所在显示器的 DPI 与工作区调整初始尺寸/位置：
    /// 200% DPI 下 720×660 DIP 会变成 1440×1320 物理像素，超出 1080p 屏幕；
    /// 这里把高度限制在工作区内（内容卡片可滚动），并居中到工作区。
    /// 注意：WPF 的 WindowStartupLocation.CenterScreen 在本机 200% DPI 下按物理像素计算左偏移，
    /// 会把窗口放到屏幕右侧之外，因此改为 SourceInitialized 里用 Win32 工作区显式定位。
    /// </summary>
    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        try
        {
            FitToWorkArea();
        }
        catch (Exception)
        {
            // 定位失败不影响安装功能，沿用 XAML 的初始尺寸/位置。
        }
    }

    private void FitToWorkArea()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        var monitor = MonitorFromWindow(handle, MonitorDefaultToNearest);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            return;
        }

        var dpiInfo = VisualTreeHelper.GetDpi(this);
        var scale = dpiInfo.DpiScaleX > 0 ? dpiInfo.DpiScaleX : 1.0;
        var workWidth = info.Work.Right - info.Work.Left;
        var workHeight = info.Work.Bottom - info.Work.Top;
        if (workWidth <= 0 || workHeight <= 0)
        {
            return;
        }

        // 保持 32 DIP 的边距；窗口内容在高度不足时由卡片内的 ScrollViewer 滚动。
        var width = Math.Min(Width, Math.Max(560, workWidth / scale - 32));
        var height = Math.Min(Height, Math.Max(420, workHeight / scale - 32));
        Width = width;
        Height = height;

        var leftPx = info.Work.Left + (workWidth - width * scale) / 2;
        var topPx = info.Work.Top + (workHeight - height * scale) / 2;
        Left = leftPx / scale;
        Top = topPx / scale;
    }

    private void OnBrowseClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择鲸鲸阅读器安装目录",
            Multiselect = false,
        };

        try
        {
            if (Directory.Exists(InstallDirBox.Text))
            {
                dialog.InitialDirectory = InstallDirBox.Text;
            }
        }
        catch (Exception)
        {
            // 无效/不可访问的初始目录不影响选择对话框。
        }

        if (dialog.ShowDialog(this) == true)
        {
            InstallDirBox.Text = dialog.FolderName;
            InlineErrorText.Visibility = Visibility.Collapsed;
        }
    }

    private async void OnInstallClick(object sender, RoutedEventArgs e)
    {
        if (_installing)
        {
            return;
        }

        InlineErrorText.Visibility = Visibility.Collapsed;

        var validation = SetupEngine.ValidateInstallDir(InstallDirBox.Text);
        if (!validation.IsValid)
        {
            ShowInlineError(validation.Error ?? "安装目录无效。");
            return;
        }

        var options = new SetupOptions(
            Silent: false,
            InstallDir: validation.NormalizedPath,
            CreateAssociation: AssocCheck.IsChecked == true,
            CreateStartMenuShortcut: true,
            CreateDesktopShortcut: DesktopCheck.IsChecked == true,
            Launch: false,
            ShowHelp: false,
            Error: null);

        SetInstalling(true);
        try
        {
            var progress = new Progress<SetupProgress>(value => StatusText.Text = value.Message);
            _result = await Task.Run(() => SetupEngine.Run(options, progress));
            ShowResult(_result);
        }
        catch (Exception exception)
        {
            ShowInlineError($"安装过程中出现未预期错误：{SetupEngine.Describe(exception)}");
        }
        finally
        {
            SetInstalling(false);
            ProgressPanel.Visibility = Visibility.Collapsed;
        }
    }

    private void OnCancelClick(object sender, RoutedEventArgs e)
    {
        if (_installing)
        {
            return;
        }

        Close();
    }

    private void OnFinishClick(object sender, RoutedEventArgs e) => Close();

    private void OnOpenAppClick(object sender, RoutedEventArgs e)
    {
        var exePath = _result?.ExePath;
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath))
        {
            MessageBox.Show(this, "找不到已安装的鲸鲸阅读器，请重新安装。", "打开失败",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = exePath,
                WorkingDirectory = Path.GetDirectoryName(exePath) ?? string.Empty,
                UseShellExecute = true,
            });
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, $"无法启动鲸鲸阅读器：{SetupEngine.Describe(exception)}", "打开失败",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OnOpenSettingsClick(object sender, RoutedEventArgs e)
        => OpenUri(SetupLogic.DefaultAppsSettingsUri, "打开「默认应用」设置失败");

    private void OnOpenRuntimeDownloadClick(object sender, RoutedEventArgs e)
        => OpenUri(SetupLogic.RuntimeDownloadUrl, "打开运行时下载页失败");

    private void OpenUri(string uri, string errorTitle)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = uri,
                UseShellExecute = true,
            });
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, $"{errorTitle}：{SetupEngine.Describe(exception)}", errorTitle,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // 安装进行中不允许关窗，避免解压到一半留下不完整安装目录。
        if (_installing)
        {
            e.Cancel = true;
            return;
        }

        base.OnClosing(e);
    }

    private void SetInstalling(bool installing)
    {
        _installing = installing;
        InstallButton.IsEnabled = !installing;
        CancelButton.IsEnabled = !installing;
        BrowseButton.IsEnabled = !installing;
        InstallDirBox.IsEnabled = !installing;
        AssocCheck.IsEnabled = !installing;
        DesktopCheck.IsEnabled = !installing;

        if (installing)
        {
            InlineErrorText.Visibility = Visibility.Collapsed;
            ResultPanel.Visibility = Visibility.Collapsed;
            ProgressPanel.Visibility = Visibility.Visible;
            StatusText.Text = "正在准备安装…";
        }
    }

    private void ShowResult(SetupResult result)
    {
        ProgressPanel.Visibility = Visibility.Collapsed;
        ResultPanel.Visibility = Visibility.Visible;
        ResultTitle.Text = result.Success ? "安装完成" : "安装未完全成功";
        ResultTitle.Foreground = result.Success ? SuccessBrush : ErrorBrush;

        var lines = new List<string>();
        if (result.Success)
        {
            lines.Add($"鲸鲸阅读器 {SetupLogic.ProductVersion} 已安装。");
        }
        else
        {
            lines.Add(result.ErrorMessage ?? "安装失败。");
            lines.Add("请修正问题后重复安装覆盖；已有安装不会被自动删除。");
        }

        lines.Add($"安装目录：{result.InstallDir}");

        if (result.AssociationRequested)
        {
            if (result.AssociationSucceeded)
            {
                lines.Add(result.IsDefaultProgram
                    ? "已将鲸鲸阅读器设为 .md 的默认程序。"
                    : "已将鲸鲸阅读器加入 .md 的「打开方式」；默认程序仍需在「默认应用」中确认一次。");
            }
            else
            {
                lines.Add($"注册 .md 打开方式失败（退出码 {result.AssociationExitCode?.ToString() ?? "未知"}）。");
            }
        }
        else
        {
            lines.Add("未修改 .md 打开方式。");
        }

        lines.Add(result.StartMenuShortcutCreated ? "已创建开始菜单快捷方式。" : "开始菜单快捷方式未创建。");
        if (DesktopCheck.IsChecked == true)
        {
            lines.Add(result.DesktopShortcutCreated ? "已创建桌面快捷方式。" : "桌面快捷方式未创建。");
        }

        lines.Add(result.UninstallEntryWritten
            ? "已写入卸载信息：设置 → 应用 → 已安装的应用 → 鲸鲸阅读器。"
            : "卸载信息写入失败；可用安装目录里的「卸载鲸鲸阅读器.exe」或 uninstall.ps1 卸载。");

        if (result.Launched)
        {
            lines.Add("已启动鲸鲸阅读器。");
        }

        ResultDetail.Text = string.Join("\n", lines);

        // 关联注册失败时不要引导用户去「默认应用」（ProgID 可能还不存在）；只在注册成功但非默认时提示。
        var needsDefaultConfirmation = result.NeedsDefaultAppConfirmation && result.AssociationSucceeded;
        DefaultPromptPanel.Visibility = needsDefaultConfirmation
            ? Visibility.Visible
            : Visibility.Collapsed;
        if (needsDefaultConfirmation)
        {
            DefaultPromptText.Text =
                "Windows 仍把 .md 的默认程序指向其它程序。请点右下角「打开「默认应用」设置」，"
                + "在列表里为 .md 选择「鲸鲸阅读器」一次（之后永久生效）。";
        }

        SettingsButton.Visibility = needsDefaultConfirmation
            ? Visibility.Visible
            : Visibility.Collapsed;
        OpenAppButton.Visibility = File.Exists(result.ExePath)
            ? Visibility.Visible
            : Visibility.Collapsed;
        FinishButton.Visibility = Visibility.Visible;
        InstallButton.Visibility = Visibility.Collapsed;
        CancelButton.Visibility = Visibility.Collapsed;
        InlineErrorText.Visibility = Visibility.Collapsed;
    }

    private void ShowInlineError(string message)
    {
        InlineErrorText.Text = message;
        InlineErrorText.Visibility = Visibility.Visible;
        ResultPanel.Visibility = Visibility.Collapsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public NativeRect Monitor;
        public NativeRect Work;
        public uint Flags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
}
