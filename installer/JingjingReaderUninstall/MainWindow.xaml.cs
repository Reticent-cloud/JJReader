using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace JingjingReader.Uninstall;

/// <summary>卸载器主窗口：确认 → 启动卸载脚本（进度）→ 结果提示。</summary>
public partial class MainWindow : Window
{
    private static readonly Brush SuccessBrush = new SolidColorBrush(Color.FromRgb(0x16, 0x79, 0x4C));
    private static readonly Brush ErrorBrush = new SolidColorBrush(Color.FromRgb(0xB4, 0x23, 0x18));

    private const uint MonitorDefaultToNearest = 2;

    private readonly string _installDir;
    private bool _starting;

    public MainWindow(string installDir)
    {
        InitializeComponent();
        _installDir = installDir;
        InstallDirText.Text = $"安装目录：{installDir}";
    }

    /// <summary>窗口关闭后作为进程退出码：启动成功 0，失败 1。</summary>
    public int ExitCode { get; private set; }

    /// <summary>
    /// 按窗口所在显示器的 DPI 与工作区居中：WPF 的 CenterScreen 在 200% DPI 下按物理像素计算左偏移，
    /// 可能把窗口放到屏幕右侧之外；这里改用 Win32 工作区显式定位（与安装器同口径）。
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
            // 定位失败不影响卸载功能，沿用 XAML 的初始尺寸/位置。
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

        var width = Math.Min(Width, Math.Max(480, workWidth / scale - 32));
        var height = Math.Min(Height, Math.Max(360, workHeight / scale - 32));
        Width = width;
        Height = height;
        Left = (info.Work.Left + (workWidth - width * scale) / 2) / scale;
        Top = (info.Work.Top + (workHeight - height * scale) / 2) / scale;
    }

    private async void OnUninstallClick(object sender, RoutedEventArgs e)
    {
        if (_starting)
        {
            return;
        }

        SetStarting(true);
        try
        {
            var result = await Task.Run(() => UninstallEngine.Start(_installDir));
            ExitCode = result.Started ? 0 : 1;
            ShowResult(result);
        }
        catch (Exception exception)
        {
            ExitCode = 1;
            ShowResult(new UninstallStartResult(
                Started: false,
                InstallDir: _installDir,
                TempDirectory: null,
                LogPath: null,
                ErrorMessage: $"卸载过程中出现未预期错误：{exception.Message}"));
        }
        finally
        {
            SetStarting(false);
        }
    }

    private void OnCancelClick(object sender, RoutedEventArgs e)
    {
        if (_starting)
        {
            return;
        }

        ExitCode = 0;
        Close();
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    protected override void OnClosing(CancelEventArgs e)
    {
        // 启动脚本期间不允许关窗，避免用户误以为卸载未开始。
        if (_starting)
        {
            e.Cancel = true;
            return;
        }

        base.OnClosing(e);
    }

    private void SetStarting(bool starting)
    {
        _starting = starting;
        UninstallButton.IsEnabled = !starting;
        CancelButton.IsEnabled = !starting;

        if (starting)
        {
            ConfirmPanel.Visibility = Visibility.Collapsed;
            ResultPanel.Visibility = Visibility.Collapsed;
            ProgressPanel.Visibility = Visibility.Visible;
            StatusText.Text = "正在准备卸载…";
        }
    }

    private void ShowResult(UninstallStartResult result)
    {
        ConfirmPanel.Visibility = Visibility.Collapsed;
        ProgressPanel.Visibility = Visibility.Collapsed;
        ResultPanel.Visibility = Visibility.Visible;

        ResultTitle.Text = result.Started ? "卸载已开始" : "无法开始卸载";
        ResultTitle.Foreground = result.Started ? SuccessBrush : ErrorBrush;

        ResultDetail.Text = result.Started && result.LogPath is not null
            ? UninstallLogic.BuildStartedText(result.InstallDir, result.LogPath)
            : UninstallLogic.BuildFailureText(result.ErrorMessage ?? "未知错误。");

        UninstallButton.Visibility = Visibility.Collapsed;
        CancelButton.Visibility = Visibility.Collapsed;
        CloseButton.Visibility = Visibility.Visible;
        CloseButton.Focus();
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
    private static extern bool GetMonitorInfo(IntPtr hwnd, ref MonitorInfo info);
}
