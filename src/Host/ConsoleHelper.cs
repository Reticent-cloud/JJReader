using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace JingjingReader;

/// <summary>WinExe 没有自带控制台；命令行输出通过附着父进程控制台实现。</summary>
public static class ConsoleHelper
{
    private const int AttachParentProcess = -1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    /// <summary>向父进程控制台输出一行；附着失败（如从资源管理器双击启动）时静默丢弃。</summary>
    public static void WriteLine(string text)
    {
        try
        {
            AttachConsole(AttachParentProcess);

            // 输出被重定向（管道/文件）时固定写 UTF-8，保证脚本与 CI 能按 UTF-8 读取中文；
            // 直接连到控制台时沿用控制台编码，由 Windows 终端正确显示中文。
            if (Console.IsOutputRedirected)
            {
                using var stdout = Console.OpenStandardOutput();
                using var writer = new StreamWriter(stdout, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
                {
                    AutoFlush = true,
                };
                writer.WriteLine(text);
            }
            else
            {
                Console.WriteLine(text);
                Console.Out.Flush();
            }
        }
        catch (Exception)
        {
            // 没有可用的标准输出时忽略：自检输出失败不能影响进程退出码。
        }
    }
}
