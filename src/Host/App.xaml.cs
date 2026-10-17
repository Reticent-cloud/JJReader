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

        var window = new MainWindow();
        MainWindow = window;

        // 命令行里的第一个非 -- 参数当作文档路径（单实例/多参数细化在 Task 13）。
        var documentPath = e.Args.FirstOrDefault(argument => !argument.StartsWith("--", StringComparison.Ordinal));
        if (!string.IsNullOrWhiteSpace(documentPath))
        {
            window.OpenDocument(documentPath);
        }

        window.Show();
    }
}
