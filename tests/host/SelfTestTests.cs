using Xunit;

namespace JingjingReader.Tests;

public class SelfTestTests
{
    [Fact]
    public void Format_contains_all_required_keys()
    {
        var text = JingjingReader.SelfTest.Format("鲸鲸阅读器", "10.0.1", "155.0.4283.45", "10.0.19045");
        Assert.Contains("产品名: 鲸鲸阅读器", text);
        Assert.Contains(".NET: 10.0.1", text);
        Assert.Contains("WebView2: 155.0.4283.45", text);
        Assert.Contains("OS: 10.0.19045", text);
    }

    [Fact]
    public void Run_contains_all_required_keys()
    {
        var text = JingjingReader.SelfTest.Run();
        Assert.Contains("产品名: 鲸鲸阅读器", text);
        Assert.Contains(".NET: ", text);
        Assert.Contains("WebView2: ", text);
        Assert.Contains("OS: ", text);
    }
}
