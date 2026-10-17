using System.Text.RegularExpressions;
using Xunit;

namespace JingjingReader.Tests;

public class SelfTestTests
{
    [Fact]
    public void Format_contains_all_required_keys_exactly()
    {
        var text = JingjingReader.SelfTest.Format("鲸鲸阅读器", "10.0.1", "155.0.4283.45", "10.0.19045");

        // 精确断言整行，避免「包含子串」让字段错位/前缀串台也蒙混通过。
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "产品名: 鲸鲸阅读器",
                ".NET: 10.0.1",
                "WebView2: 155.0.4283.45",
                "OS: 10.0.19045"),
            text);
    }

    [Fact]
    public void Run_contains_all_required_keys_with_version_shapes()
    {
        var text = JingjingReader.SelfTest.Run();

        Assert.Matches(new Regex(@"^产品名: 鲸鲸阅读器\r?$", RegexOptions.Multiline), text);
        // 版本必须是「数字.数字.数字…」形状，不接受「未知」/空串之类的占位
        Assert.Matches(new Regex(@"^\.NET: \d+\.\d+(?:\.\d+)*\r?$", RegexOptions.Multiline), text);
        Assert.Matches(new Regex(@"^WebView2: (?:\d+\.\d+(?:\.\d+)*|未检测到)\r?$", RegexOptions.Multiline), text);
        Assert.Matches(new Regex(@"^OS: \d+\.\d+(?:\.\d+)*\r?$", RegexOptions.Multiline), text);
    }
}
