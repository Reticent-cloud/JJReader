using System.IO;
using System.Reflection;
using System.Windows;

namespace JingjingReader;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Contains("--selftest"))
        {
            ConsoleHelper.WriteLine(SelfTest.Run());
            Shutdown(0);
            return;
        }

        // --verify-render <file>：离屏自检，不显示正常窗口。
        var verifyIndex = Array.IndexOf(e.Args, "--verify-render");
        if (verifyIndex >= 0)
        {
            if (verifyIndex + 1 >= e.Args.Length)
            {
                ConsoleHelper.WriteLine("用法：JingjingReader.exe --verify-render <markdown 文件>");
                Shutdown(2);
                return;
            }

            _ = VerifyRender.Run(e.Args[verifyIndex + 1]);
            return;
        }

        // --verify-pdf <in.md> <out.pdf>：离屏打开文档 → 打印模式 → PrintToPdf，成功 exit 0（Task 15）。
        var verifyPdfIndex = Array.IndexOf(e.Args, "--verify-pdf");
        if (verifyPdfIndex >= 0)
        {
            if (verifyPdfIndex + 2 >= e.Args.Length)
            {
                ConsoleHelper.WriteLine("用法：JingjingReader.exe --verify-pdf <markdown 文件> <输出 PDF>");
                Shutdown(2);
                return;
            }

            _ = VerifyPdf.Run(e.Args[verifyPdfIndex + 1], e.Args[verifyPdfIndex + 2]);
            return;
        }

        // --install / --uninstall（Task 16）：只写/删 HKCU 下的 .md 关联，不显示窗口。
        if (e.Args.Contains("--install"))
        {
            RunAssociationCommand(install: true);
            return;
        }

        if (e.Args.Contains("--uninstall"))
        {
            RunAssociationCommand(install: false);
            return;
        }

        // 命令行里的第一个非 -- 参数当作文档路径。
        var documentPath = e.Args.FirstOrDefault(argument => !argument.StartsWith("--", StringComparison.Ordinal));

        // 单实例（Task 13）：后启动的实例把文档路径（没有参数则空串＝只激活窗口）转交主实例后立即退出。
        if (!SingleInstance.TryAcquire())
        {
            try
            {
                // 同步等发送完成再退出：Shutdown 会结束消息循环，异步发送可能还没写出就被进程退出截断。
                _ = SingleInstance.TrySendAsync(documentPath ?? string.Empty).GetAwaiter().GetResult();
            }
            catch (Exception exception)
            {
                // 转交失败也照常退出：不能让第二个实例变成未处理异常
                DebugLog.Write($"单实例转交失败：{exception}");
            }

            Shutdown(0);
            return;
        }

        var window = new MainWindow();
        MainWindow = window;

        // 主实例：后台管道收到路径后在 UI 线程切换文档（空串只激活已有窗口，主实例不新开窗口）。
        IpcServer.Start(
            SingleInstance.MutexName + ".pipe",
            path => Dispatcher.Invoke(() =>
            {
                if (string.IsNullOrWhiteSpace(path))
                {
                    window.Activate();
                    window.Focus();
                    return;
                }

                window.OpenDocument(path);
            }));

        if (!string.IsNullOrWhiteSpace(documentPath))
        {
            window.OpenDocument(documentPath);
        }

        window.Show();
    }

    /// <summary>
    /// <c>--install</c> / <c>--uninstall</c> 的命令行入口：不建窗口、不参与单实例，只操作 HKCU 并输出中文结果。
    /// 成功退出码 0、失败 1；异常必须转成消息 + 退出码，不能冒泡成未处理异常。
    /// 用命名 Mutex 串行化并发的安装/卸载命令（双击两次、脚本与 exe 同时跑）。
    /// </summary>
    private void RunAssociationCommand(bool install)
    {
        try
        {
            using var commandLock = Assoc.TryAcquireCommandMutex();
            if (commandLock is null)
            {
                ConsoleHelper.WriteLine("另一个安装/卸载正在进行，请稍后再试。");
                DebugLog.Write($"{(install ? "install" : "uninstall")} 未执行：另一个安装/卸载正在进行");
                Shutdown(1);
                return;
            }

            var registry = new Win32AssocRegistry();
            if (install)
            {
                var exePath = ResolveExecutablePath();
                Assoc.Install(registry, exePath, AppPaths.AssocBackupPath);
                var state = Assoc.GetState(registry);
                ConsoleHelper.WriteLine($"已注册 .md 的打开方式：{exePath}");
                ConsoleHelper.WriteLine(state.IsDefault
                    ? "鲸鲸阅读器已是默认 .md 程序。"
                    : "若 .md 已有默认程序，请到 设置→默认应用 选择鲸鲸阅读器。");
                DebugLog.Write("install 完成");
                Shutdown(0);
                return;
            }

            var backupPath = AppPaths.AssocBackupPath;
            var result = Assoc.Uninstall(registry, backupPath);
            switch (result)
            {
                case AssocUninstallResult.RestoredFromBackup:
                    ConsoleHelper.WriteLine("已卸载 .md 文件关联，并恢复安装前的状态。");
                    break;

                case AssocUninstallResult.RemovedWithoutBackup:
                    ConsoleHelper.WriteLine("备份缺失，已删除本程序写入的 .md 关联项（安装前的 ProgID 细节无法还原）。");
                    break;

                case AssocUninstallResult.BackupCorrupt:
                    ConsoleHelper.WriteLine($"关联备份文件已损坏，未改动注册表：{backupPath}");
                    ConsoleHelper.WriteLine("请检查或删除该备份文件后重试。");
                    DebugLog.Write("uninstall 中止：备份损坏，未改动注册表");
                    Shutdown(1);
                    return;

                case AssocUninstallResult.BackupIncompatible:
                    ConsoleHelper.WriteLine($"关联备份版本不兼容（schemaVersion != 1），未改动注册表：{backupPath}");
                    ConsoleHelper.WriteLine("请检查或删除该备份文件后重试。");
                    DebugLog.Write("uninstall 中止：备份版本不兼容，未改动注册表");
                    Shutdown(1);
                    return;

                default:
                    throw new InvalidOperationException($"未知的卸载结果：{result}");
            }

            DebugLog.Write("uninstall 完成");
            Shutdown(0);
        }
        catch (Exception exception)
        {
            DebugLog.Write($"{(install ? "install" : "uninstall")} 失败：{exception}");
            ConsoleHelper.WriteLine($"{(install ? "安装" : "卸载")}文件关联失败：{exception.Message}");
            Shutdown(1);
        }
    }

    /// <summary>
    /// 带 <c>--install</c> 启动时应注册的可执行文件路径：
    /// 正常 exe 启动用 <see cref="Environment.ProcessPath"/>；<c>dotnet JingjingReader.dll --install</c>
    /// 时 ProcessPath 是 dotnet.exe，改用入口程序集所在目录的同名 apphost（JingjingReader.exe），
    /// 避免把 dotnet.exe 注册成 .md 的打开方式。找不到 apphost 时报错（由调用方转成 exit 1）。
    /// </summary>
    private static string ResolveExecutablePath()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath) && !IsDotnetHost(processPath))
        {
            return Path.GetFullPath(processPath);
        }

        // 单文件发布时 Assembly.Location 为空字符串；此处是 dotnet 宿主/兜底场景，取入口程序集路径。
#pragma warning disable IL3000
        var assemblyPath = Assembly.GetEntryAssembly()?.Location;
#pragma warning restore IL3000
        if (string.IsNullOrWhiteSpace(assemblyPath))
        {
            throw new InvalidOperationException("无法确定程序自身路径（进程路径与入口程序集均不可用）。");
        }

        var assemblyDirectory = Path.GetDirectoryName(assemblyPath);
        var exePath = Path.Combine(assemblyDirectory ?? string.Empty, Path.GetFileNameWithoutExtension(assemblyPath) + ".exe");
        if (!File.Exists(exePath))
        {
            throw new InvalidOperationException(
                $"未找到程序可执行文件：{exePath}；请先构建 apphost 或直接运行 JingjingReader.exe --install。");
        }

        return Path.GetFullPath(exePath);
    }

    /// <summary>判断进程路径是否是 .NET 宿主（dotnet / dotnet.exe）。</summary>
    private static bool IsDotnetHost(string path)
        => string.Equals(Path.GetFileNameWithoutExtension(path), "dotnet", StringComparison.OrdinalIgnoreCase);
}
