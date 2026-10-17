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
}
