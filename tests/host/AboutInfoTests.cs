using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 16：关于面板的纯文本格式（版本、环境、数据目录、.md 关联状态）。
/// 窗口本身不在这里测试；这里只锁定可复用的字符串格式，避免 UI 文案散落在事件处理里。
/// </summary>
public class AboutInfoTests
{
    [Fact]
    public void Format_contains_product_version_and_environment_fields()
    {
        var text = AboutInfo.Format("鲸鲸阅读器", "0.1.0", "10.0.1", "155.0.4283.45", "10.0.19045");

        Assert.Contains("鲸鲸阅读器 0.1.0", text);
        Assert.Contains(".NET: 10.0.1", text);
        Assert.Contains("WebView2 155.0.4283.45", text);
        Assert.Contains("OS: 10.0.19045", text);
    }

    [Fact]
    public void FormatVersion_hides_zero_revision_but_keeps_build()
    {
        Assert.Equal("0.1.0", AboutInfo.FormatVersion(new Version(0, 1, 0, 0)));
        Assert.Equal("1.2.3.4", AboutInfo.FormatVersion(new Version(1, 2, 3, 4)));
        Assert.Equal("2.5", AboutInfo.FormatVersion(new Version(2, 5)));
        Assert.Equal("未知", AboutInfo.FormatVersion(null));
    }

    [Theory]
    [InlineData(false, false, "未注册")]
    [InlineData(true, false, "未设为默认 .md 程序")]
    [InlineData(true, true, "默认 .md 程序")]
    public void AssocText_covers_all_three_states(bool registered, bool isDefault, string expected)
    {
        Assert.Contains(expected, AboutInfo.AssocText(registered, isDefault));
    }

    [Fact]
    public void BuildText_includes_data_directory_and_assoc_state()
    {
        var text = AboutInfo.BuildText(
            "0.1.0",
            "10.0.1",
            "未检测到",
            "10.0.19045",
            @"C:\Users\me\AppData\Roaming\JingjingReader",
            registered: true,
            isDefault: false);

        Assert.Contains("鲸鲸阅读器 0.1.0", text);
        Assert.Contains(@"数据目录: C:\Users\me\AppData\Roaming\JingjingReader", text);
        Assert.Contains("已注册", text);
        Assert.Contains("未设为默认 .md 程序", text);
    }
}
