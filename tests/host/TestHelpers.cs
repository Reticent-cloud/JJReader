using System.Collections.Concurrent;
using System.IO;

namespace JingjingReader.Tests;

/// <summary>宿主测试共用的临时目录辅助。目录建在系统临时区，进程退出时尽力清理。</summary>
internal static class TestHelpers
{
    private static readonly ConcurrentBag<string> CreatedDirs = new();

    static TestHelpers()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Cleanup();
    }

    /// <summary>新建一个唯一的临时目录并返回其绝对路径；退出时递归删除。</summary>
    public static string TestDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jingjing-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        CreatedDirs.Add(dir);
        return dir;
    }

    private static void Cleanup()
    {
        foreach (var dir in CreatedDirs)
        {
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, recursive: true);
                }
            }
            catch (Exception)
            {
                // 清理失败不影响测试结果：文件可能仍被其他测试或杀毒软件短暂占用。
            }
        }
    }
}
