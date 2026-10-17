using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;

namespace JingjingReader;

public partial class App : Application
{
    /// <summary>UI 线程异常只提示一次（异常风暴时避免刷屏）；完整异常始终写 debug.log。</summary>
    private bool _uiErrorToastShown;

    public App()
    {
        // I4（spec §4.2）：三类全局异常兜底在 Application 建立时注册，覆盖启动早期（窗口尚未创建）的异常。
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
    }

    /// <summary>
    /// UI 线程未处理异常：完整异常写 debug.log；非致命异常标记 Handled 让阅读继续，并弹一次 toast。
    /// 内存耗尽/栈溢出/访问冲突属于不可恢复错误，交给进程终止（吞掉只会留下更坏的状态）。
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        DebugLog.Write($"未处理的 UI 异常：{e.Exception}");
        if (IsFatal(e.Exception))
        {
            return;
        }

        e.Handled = true;
        if (_uiErrorToastShown)
        {
            return;
        }

        _uiErrorToastShown = true;
        if (MainWindow is JingjingReader.MainWindow window)
        {
            window.ShowRecoverableError("发生内部错误，已记录日志，可以继续阅读");
        }
    }

    /// <summary>非 UI 线程未处理异常：只能记录（进程即将终止），不能 recover。</summary>
    private static void OnDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        var exception = e.ExceptionObject as Exception;
        DebugLog.Write($"未处理的后台异常（即将终止={e.IsTerminating}）：{exception}");
    }

    /// <summary>未被观察的 Task 异常：记录并标记已观察，避免进程在 GC 终结时崩溃。</summary>
    private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        DebugLog.Write($"未观察的 Task 异常：{e.Exception}");
        e.SetObserved();
    }

    /// <summary>不可恢复异常（吞掉只会让进程停在损坏状态）。</summary>
    private static bool IsFatal(Exception exception)
        => exception is OutOfMemoryException or StackOverflowException or AccessViolationException;

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
        // I2（修复波 B）：两个分支都先把最小化窗口还原并 Show/Activate，再打开路径——
        // 只 Activate 一个最小化窗口不会把它带回屏幕。管道名跟着 SingleInstance 的有效 mutex 名走
        // （Global 无权限时退化到 Local）。
        IpcServer.Start(
            SingleInstance.PipeName,
            path => Dispatcher.Invoke(() =>
            {
                window.BringToForeground();
                if (string.IsNullOrWhiteSpace(path))
                {
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
            var outcome = Assoc.UninstallDetailed(registry, backupPath);
            switch (outcome.Result)
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
                    throw new InvalidOperationException($"未知的卸载结果：{outcome.Result}");
            }

            // C1（关联收尾）：Windows UserChoice 受系统保护，程序无法程序化恢复；仍指向本程序时明确提示
            // 用户去「默认应用」重新选择，但这是警告而非失败（退出码仍为 0）。
            if (outcome.UserChoiceNeedsReselect)
            {
                ConsoleHelper.WriteLine(
                    "警告：Windows 的 .md 默认应用仍指向鲸鲸阅读器（UserChoice）。" +
                    "卸载后请在 设置 → 应用 → 默认应用 中重新选择 .md 的默认程序（ms-settings:defaultapps）。");
                DebugLog.Write("uninstall 完成，但 UserChoice 仍指向本程序，已提示用户重新选择默认应用");
            }
            else
            {
                DebugLog.Write("uninstall 完成");
            }

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
