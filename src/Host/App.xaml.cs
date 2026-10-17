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
    /// </summary>
    private void RunAssociationCommand(bool install)
    {
        try
        {
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
            }
            else
            {
                // 卸载前判断备份是否存在，用于区分「恢复安装前状态」与「备份缺失的尽力还原」。
                var hadBackup = File.Exists(AppPaths.AssocBackupPath);
                Assoc.Uninstall(registry, AppPaths.AssocBackupPath);
                ConsoleHelper.WriteLine(hadBackup
                    ? "已卸载 .md 文件关联，并恢复安装前的状态。"
                    : "未找到备份，已还原为本程序可识别的部分。");
            }

            DebugLog.Write(install ? "install 完成" : "uninstall 完成");
            Shutdown(0);
        }
        catch (Exception exception)
        {
            DebugLog.Write($"{(install ? "install" : "uninstall")} 失败：{exception}");
            ConsoleHelper.WriteLine($"{(install ? "安装" : "卸载")}文件关联失败：{exception.Message}");
            Shutdown(1);
        }
    }

    /// <summary>带 --install 启动的程序自身路径：优先进程路径（publish 后的 exe），回退程序集位置。</summary>
    private static string ResolveExecutablePath()
    {
        var path = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(path))
        {
            // 单文件发布时 Assembly.Location 为空字符串，这里只是 ProcessPath 缺失时的兜底。
#pragma warning disable IL3000
            path = Assembly.GetEntryAssembly()?.Location;
#pragma warning restore IL3000
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("无法确定程序自身路径");
        }

        return Path.GetFullPath(path);
    }
}
