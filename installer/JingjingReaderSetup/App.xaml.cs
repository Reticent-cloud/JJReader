using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Windows;
using Microsoft.Win32;

namespace JingjingReader.Setup;

/// <summary>
/// 安装器入口：无参数进图形界面；<c>--silent</c> 不建窗口，直接安装并输出结果。
/// 静默模式退出码：0 成功、1 安装失败、2 参数错误。
/// </summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var options = SetupLogic.ParseArgs(e.Args, ResolveDefaultInstallDir());

        if (e.Args.Contains("--diagnose", StringComparer.OrdinalIgnoreCase))
        {
            PrintDiagnostics();
            Shutdown(0);
            return;
        }

        if (options.ShowHelp)
        {
            ConsoleOutput.WriteLine(SetupLogic.UsageText);
            Shutdown(0);
            return;
        }

        if (options.Silent)
        {
            if (options.Error is not null)
            {
                ConsoleOutput.WriteLine($"错误：{options.Error}");
                ConsoleOutput.WriteLine(SetupLogic.UsageText);
                Shutdown(2);
                return;
            }

            var result = SetupEngine.Run(options, new ConsoleProgress());
            PrintSilentResult(result);
            Shutdown(result.Success ? 0 : 1);
            return;
        }

        // 图形界面：未知参数不阻断安装（用已解析的安装目录预填，其余参数忽略）。
        var window = new MainWindow(options, GetRuntimeWarning());
        MainWindow = window;
        window.Show();
    }

    private static string ResolveDefaultInstallDir()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        }

        if (string.IsNullOrWhiteSpace(localAppData))
        {
            // 极端环境（LocalAppData 被禁用）下退到临时目录，仍然可安装。
            localAppData = Path.Combine(Path.GetTempPath(), "JingjingReader");
        }

        return SetupLogic.GetDefaultInstallDir(localAppData);
    }

    /// <summary>
    /// 运行时检查：目标机与安装器都需要 .NET 10 Desktop Runtime。
    /// 安装器自身是框架依赖的（缺失时 .NET 宿主会先给出安装提示），这里检查标准安装位置并在 UI 顶部提示。
    /// </summary>
    private static string? GetRuntimeWarning()
    {
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (string.IsNullOrWhiteSpace(dotnetRoot))
        {
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (string.IsNullOrWhiteSpace(programFiles))
            {
                return null;
            }

            dotnetRoot = Path.Combine(programFiles, "dotnet");
        }

        return SetupLogic.CheckRuntime(
            Environment.Version,
            SetupLogic.GetDesktopRuntimeSharedDir(dotnetRoot));
    }

    private static void PrintSilentResult(SetupResult result)
    {
        if (result.Success)
        {
            ConsoleOutput.WriteLine("安装成功。");
        }
        else
        {
            ConsoleOutput.WriteLine($"安装失败：{result.ErrorMessage}");
        }

        if (!string.IsNullOrWhiteSpace(result.InstallDir))
        {
            ConsoleOutput.WriteLine($"安装目录：{result.InstallDir}");
            ConsoleOutput.WriteLine($"程序：{result.ExePath}");
        }

        if (result.AssociationRequested)
        {
            if (result.AssociationSucceeded)
            {
                ConsoleOutput.WriteLine($"已注册 .md 打开方式：{SetupLogic.ProgId}");
                ConsoleOutput.WriteLine(
                    result.IsDefaultProgram
                        ? "当前鲸鲸阅读器是 .md 的默认程序。"
                        : "提示：Windows 仍把 .md 的默认程序指向其它程序。"
                          + "请打开「设置 → 应用 → 默认应用」，为 .md 选择「鲸鲸阅读器」一次（之后永久生效）："
                          + SetupLogic.DefaultAppsSettingsUri);
            }
            else
            {
                ConsoleOutput.WriteLine(
                    $"注册 .md 打开方式失败（退出码 {result.AssociationExitCode?.ToString() ?? "未知"}）。");
                if (!string.IsNullOrWhiteSpace(result.AssociationOutput))
                {
                    ConsoleOutput.WriteLine(result.AssociationOutput);
                }
            }
        }

        ConsoleOutput.WriteLine(
            result.UninstallEntryWritten
                ? "已写入卸载信息：设置 → 应用 → 已安装的应用 → 鲸鲸阅读器。"
                : "警告：卸载信息写入失败，可通过安装目录里的 uninstall.ps1 卸载。");

        if (result.Launched)
        {
            ConsoleOutput.WriteLine("已启动鲸鲸阅读器。");
        }

        foreach (var warning in result.Warnings)
        {
            ConsoleOutput.WriteLine($"提示：{warning}");
        }
    }

    private sealed class ConsoleProgress : IProgress<SetupProgress>
    {
        public void Report(SetupProgress value) => ConsoleOutput.WriteLine($"[setup] {value.Message}");
    }

    /// <summary>诊断输出（隐藏参数 --diagnose）：用于排查权限/运行时环境问题。</summary>
    private static void PrintDiagnostics()
    {
        var identity = WindowsIdentity.GetCurrent();
        var principal = new WindowsPrincipal(identity);
        ConsoleOutput.WriteLine($"用户：{Environment.UserName}");
        ConsoleOutput.WriteLine($"身份：{identity.Name}");
        ConsoleOutput.WriteLine($"管理员：{principal.IsInRole(WindowsBuiltInRole.Administrator)}");
        ConsoleOutput.WriteLine($".NET：{Environment.Version}");
        ConsoleOutput.WriteLine($"进程：{Environment.ProcessPath}");
        ConsoleOutput.WriteLine($"当前目录：{Environment.CurrentDirectory}");
        ConsoleOutput.WriteLine($"临时目录：{Path.GetTempPath()}");

        try
        {
            var probe = Path.Combine(Path.GetTempPath(), "jj-setup-probe-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(probe);
            ConsoleOutput.WriteLine("临时目录写入：OK");
            Directory.Delete(probe, recursive: true);
        }
        catch (Exception exception)
        {
            ConsoleOutput.WriteLine($"临时目录写入：失败（{exception.GetType().Name}: {exception.Message}）");
        }

        try
        {
            var probeKey = @"Software\JingjingReaderSetupProbe";
            using (var key = Registry.CurrentUser.CreateSubKey(probeKey, writable: true))
            {
                key?.SetValue("probe", "1");
            }

            Registry.CurrentUser.DeleteSubKeyTree(probeKey, throwOnMissingSubKey: false);
            ConsoleOutput.WriteLine("HKCU 写入：OK");
        }
        catch (Exception exception)
        {
            ConsoleOutput.WriteLine($"HKCU 写入：失败（{exception.GetType().Name}: {exception.Message}）");
        }

        try
        {
            var process = new Process
            {
                StartInfo = new ProcessStartInfo("whoami.exe", "/groups")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                },
            };
            if (process.Start())
            {
                ConsoleOutput.WriteLine(process.StandardOutput.ReadToEnd().Trim());
                process.WaitForExit(5_000);
            }
        }
        catch (Exception exception)
        {
            ConsoleOutput.WriteLine($"whoami /groups 失败：{exception.Message}");
        }
    }
}
