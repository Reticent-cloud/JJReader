using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// I3（spec §5.11）：WebView2 运行时缺失/初始化失败的原生对话框模型。
/// 只测纯函数（对话框本身是 WPF 交互，见手测清单）。
/// </summary>
public class WebView2StartupFailureTests
{
    [Fact]
    public void Runtime_not_found_produces_download_guidance()
    {
        var exception = new Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException("没有安装运行时");

        var model = WebView2StartupFailure.BuildDialogModel(exception);

        Assert.True(model.RuntimeMissing);
        Assert.Equal("无法启动 WebView2", model.Title);
        Assert.Contains("未检测到", model.Summary);
        Assert.Contains("WebView2", model.Summary);
        Assert.Equal("https://developer.microsoft.com/microsoft-edge/webview2/", model.DownloadUrl);
        Assert.Equal("下载 WebView2 运行时", model.DownloadButtonText);
        Assert.Equal("打开数据目录", model.OpenDataDirButtonText);
        Assert.Equal("关闭", model.CloseButtonText);
        Assert.Contains("WebView2RuntimeNotFoundException", model.Detail);
    }

    [Fact]
    public void Wrapped_runtime_exception_is_detected()
    {
        var exception = new InvalidOperationException(
            "初始化失败",
            new Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException("missing"));

        Assert.True(WebView2StartupFailure.BuildDialogModel(exception).RuntimeMissing);
    }

    [Fact]
    public void Other_initialization_failure_keeps_generic_message()
    {
        var model = WebView2StartupFailure.BuildDialogModel(new InvalidOperationException("HRESULT 0x80070005"));

        Assert.False(model.RuntimeMissing);
        Assert.Contains("初始化失败", model.Summary);
        Assert.Contains("0x80070005", model.Detail);
        Assert.Equal(WebView2StartupFailure.DownloadUrl, model.DownloadUrl);
    }

    [Fact]
    public void Null_exception_is_rejected()
    {
        Assert.Throws<ArgumentNullException>(() => WebView2StartupFailure.BuildDialogModel(null!));
    }
}
