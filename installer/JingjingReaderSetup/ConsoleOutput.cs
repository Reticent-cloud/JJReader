using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace JingjingReader.Setup;

/// <summary>
/// WinExe 没有自带控制台：静默安装通过附着父进程控制台输出结果（与宿主 <c>ConsoleHelper</c> 同口径）。
/// 输出被重定向（管道/文件）时固定 UTF-8，保证脚本/CI 能正确读取中文。
/// </summary>
internal static class ConsoleOutput
{
    private const int AttachParentProcess = -1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    /// <summary>写一行；没有可用控制台/标准输出时静默丢弃，不影响退出码。</summary>
    public static void WriteLine(string text)
    {
        try
        {
            AttachConsole(AttachParentProcess);

            if (Console.IsOutputRedirected)
            {
                using var stdout = Console.OpenStandardOutput();
                using var writer = new StreamWriter(
                    stdout,
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
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
            // 没有控制台（资源管理器双击）时静默忽略：静默模式的主要调用方是脚本。
        }
    }
}
