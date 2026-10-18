using System.IO;
using System.Runtime.InteropServices;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// WebView2 启动失败的自助恢复：识别 0x800700AA（用户数据目录被占用）与重置缓存目录。
/// </summary>
public class WebView2RecoveryTests
{
    [Fact]
    public void IsResourceBusy_detects_busy_com_exception_in_chain()
    {
        var nested = new InvalidOperationException("初始化失败",
            new COMException("资源被占用", WebView2Recovery.ErrorBusy));

        Assert.True(WebView2Recovery.IsResourceBusy(nested));
        Assert.False(WebView2Recovery.IsResourceBusy(new InvalidOperationException("其它错误")));
        Assert.False(WebView2Recovery.IsResourceBusy(null));
    }

    [Fact]
    public void TryReset_moves_folder_to_timestamped_backup()
    {
        var root = TestHelpers.TestDir();
        var folder = Path.Combine(root, "WebView2");
        Directory.CreateDirectory(Path.Combine(folder, "EBWebView"));
        File.WriteAllText(Path.Combine(folder, "EBWebView", "marker.txt"), "cached");

        var reset = WebView2Recovery.TryResetUserDataFolder(
            folder,
            new DateTimeOffset(2026, 10, 18, 11, 30, 0, TimeSpan.FromHours(8)),
            out var backup);

        Assert.True(reset);
        Assert.False(Directory.Exists(folder));
        Assert.True(Directory.Exists(backup));
        Assert.Contains("WebView2.bak-20261018113000", backup);
        Assert.Equal("cached", File.ReadAllText(Path.Combine(backup, "EBWebView", "marker.txt")));
    }

    [Fact]
    public void TryReset_missing_folder_counts_as_reset()
    {
        var root = TestHelpers.TestDir();
        var reset = WebView2Recovery.TryResetUserDataFolder(Path.Combine(root, "缺失"), DateTimeOffset.Now, out var backup);

        Assert.True(reset);
        Assert.Equal(string.Empty, backup);
    }

    [Fact]
    public void TryReset_invalid_input_returns_false()
    {
        Assert.False(WebView2Recovery.TryResetUserDataFolder("", DateTimeOffset.Now, out var backup));
        Assert.Equal(string.Empty, backup);
    }

    [Fact]
    public void TryReset_same_second_collision_gets_suffix()
    {
        var root = TestHelpers.TestDir();
        var folder = Path.Combine(root, "WebView2");
        var when = new DateTimeOffset(2026, 10, 18, 11, 30, 0, TimeSpan.FromHours(8));

        Directory.CreateDirectory(folder);
        Assert.True(WebView2Recovery.TryResetUserDataFolder(folder, when, out var first));
        Directory.CreateDirectory(folder);
        Assert.True(WebView2Recovery.TryResetUserDataFolder(folder, when, out var second));

        Assert.NotEqual(first, second);
        Assert.Contains("-1", second);
    }
}
