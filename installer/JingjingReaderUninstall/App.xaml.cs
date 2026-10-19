using System.IO;
using System.Windows;

namespace JingjingReader.Uninstall;

/// <summary>
/// 卸载器入口：无参数进确认窗口；<c>--silent</c> 不建窗口，启动卸载脚本后立即返回。
/// 静默退出码：0 = 已成功启动卸载脚本、1 = 启动失败、2 = 参数错误。
/// </summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var defaultInstallDir = ResolveDefaultInstallDir();
        var options = UninstallLogic.ParseArgs(e.Args, defaultInstallDir);

        if (options.ShowHelp)
        {
            ConsoleOutput.WriteLine(UninstallLogic.UsageText);
            Shutdown(0);
            return;
        }

        if (options.Error is not null)
        {
            if (options.Silent)
            {
                ConsoleOutput.WriteLine($"错误：{options.Error}");
                ConsoleOutput.WriteLine(UninstallLogic.UsageText);
            }
            else
            {
                MessageBox.Show(
                    $"{options.Error}\n\n{UninstallLogic.UsageText}",
                    "卸载鲸鲸阅读器",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }

            Shutdown(2);
            return;
        }

        string installDir;
        try
        {
            installDir = UninstallLogic.ResolveInstallDir(options.InstallDir, defaultInstallDir);
        }
        catch (Exception exception)
        {
            if (options.Silent)
            {
                ConsoleOutput.WriteLine($"错误：{exception.Message}");
            }
            else
            {
                MessageBox.Show(
                    exception.Message,
                    "卸载鲸鲸阅读器",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }

            Shutdown(2);
            return;
        }

        if (options.Silent)
        {
            var result = UninstallEngine.Start(installDir);
            PrintSilentResult(result);
            Shutdown(result.Started ? 0 : 1);
            return;
        }

        var window = new MainWindow(installDir);
        MainWindow = window;
        window.Closed += (_, _) => Shutdown(window.ExitCode);
        window.Show();
    }

    private static string ResolveDefaultInstallDir()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath))
        {
            return UninstallLogic.GetDefaultInstallDir(processPath);
        }

        var baseDirectory = AppContext.BaseDirectory;
        if (string.IsNullOrWhiteSpace(baseDirectory))
        {
            baseDirectory = Environment.CurrentDirectory;
        }

        return UninstallLogic.GetDefaultInstallDir(
            Path.Combine(baseDirectory, UninstallLogic.UninstallerFileName));
    }

    private static void PrintSilentResult(UninstallStartResult result)
    {
        if (result.Started)
        {
            ConsoleOutput.WriteLine("已启动卸载脚本。");
            ConsoleOutput.WriteLine($"安装目录：{result.InstallDir}");
            if (!string.IsNullOrWhiteSpace(result.LogPath))
            {
                ConsoleOutput.WriteLine($"日志：{result.LogPath}");
            }

            ConsoleOutput.WriteLine("提示：卸载器退出后脚本会删除安装目录；设置/最近/阅读位置会保留。");
            return;
        }

        ConsoleOutput.WriteLine($"卸载失败：{result.ErrorMessage}");
    }
}
