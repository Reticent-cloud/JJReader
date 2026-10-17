using System.Diagnostics;
using System.Reflection;
using System.Windows;

namespace JingjingReader;

/// <summary>
/// 关于面板（Task 16）：显示产品/版本/.NET/WebView2/OS、数据目录与当前 .md 关联状态，
/// 并提供「打开默认应用设置 / 打开数据目录 / 复制诊断信息」三个动作。
/// 由 MainWindow 以 ShowDialog 打开（Owner=主窗口，居中）；自身不写注册表。
/// </summary>
public partial class AboutWindow : Window
{
    private readonly string _diagnostics;

    public AboutWindow()
    {
        InitializeComponent();

        var (registered, isDefault) = ReadAssocState();
        _diagnostics = AboutInfo.BuildText(
            AboutInfo.FormatVersion(Assembly.GetExecutingAssembly().GetName().Version),
            Environment.Version.ToString(),
            SelfTest.WebView2Version,
            Environment.OSVersion.Version.ToString(),
            AppPaths.DataDir,
            registered,
            isDefault);
        InfoText.Text = _diagnostics;
    }

    /// <summary>实时读 HKCU 关联状态；权限等异常按「未注册」降级（关于面板不能因此打不开）。</summary>
    private static (bool Registered, bool IsDefault) ReadAssocState()
    {
        try
        {
            return Assoc.GetState(new Win32AssocRegistry());
        }
        catch (Exception exception)
        {
            DebugLog.Write($"关于面板读取 .md 关联状态失败：{exception.Message}");
            return (false, false);
        }
    }

    private void OnOpenDefaultApps(object sender, RoutedEventArgs e)
        => OpenShellTarget("ms-settings:defaultapps");

    private void OnOpenDataDir(object sender, RoutedEventArgs e)
        => OpenShellTarget(AppPaths.DataDir);

    private void OnCopyDiagnostics(object sender, RoutedEventArgs e)
    {
        try
        {
            Clipboard.SetText(_diagnostics);
        }
        catch (Exception exception)
        {
            // 剪贴板被其它进程占用时只记日志：关于面板不能因此崩溃。
            DebugLog.Write($"复制诊断信息失败：{exception.Message}");
        }
    }

    /// <summary>交给 Shell 打开（UWP 设置页 / 资源管理器）；失败静默记日志。</summary>
    private static void OpenShellTarget(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            DebugLog.Write($"关于面板打开：{target}");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"关于面板打开失败 target={target}：{exception.Message}");
        }
    }
}
