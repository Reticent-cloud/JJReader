using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// M2（spec §7）：debug.log 超过 256 KB 滚动为 debug.log.1/.2，最多保留 3 份；
/// 写入失败静默（这里只验证滚动与静默语义，不碰真实 %APPDATA%）。
/// </summary>
public class DebugLogTests
{
    private static string NewLogPath() => Path.Combine(TestHelpers.TestDir(), "debug.log");

    [Fact]
    public void Writes_timestamped_line_and_creates_directory()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "nested", "debug.log");

        DebugLog.WriteTo(path, "hello");

        var text = File.ReadAllText(path);
        Assert.Contains("hello", text);
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}", text);
    }

    [Fact]
    public void Rolls_to_dot_1_when_file_exceeds_limit()
    {
        var path = NewLogPath();
        File.WriteAllText(path, new string('x', (int)DebugLog.MaxFileBytes + 1));

        DebugLog.WriteTo(path, "after-roll");

        Assert.True(File.Exists(path + ".1"), "超过 256 KB 应滚动出 debug.log.1");
        Assert.Contains("after-roll", File.ReadAllText(path));
        Assert.DoesNotContain("after-roll", File.ReadAllText(path + ".1"));
    }

    [Fact]
    public void Keeps_at_most_three_files()
    {
        var path = NewLogPath();
        var payload = new string('y', (int)DebugLog.MaxFileBytes + 1);

        for (var index = 0; index < 4; index += 1)
        {
            DebugLog.WriteTo(path, payload);
        }

        Assert.True(File.Exists(path));
        Assert.True(File.Exists(path + ".1"));
        Assert.True(File.Exists(path + ".2"));
        Assert.False(File.Exists(path + ".3"), "最多保留 3 份（debug.log + .1 + .2）");
    }

    [Fact]
    public void WriteTo_empty_path_is_silent_noop()
    {
        DebugLog.WriteTo(string.Empty, "ignored");
        DebugLog.WriteTo("   ", "ignored");
    }

    [Fact]
    public void Unwritable_path_is_silent()
    {
        // 把目录路径当文件写：必须静默（日志失败不能影响主流程）
        var path = TestHelpers.TestDir();

        DebugLog.WriteTo(path, "cannot write");
    }
}
