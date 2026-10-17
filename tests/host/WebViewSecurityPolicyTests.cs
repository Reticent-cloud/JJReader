using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 评审 C2：NavigateToString 文档的消息来源与导航策略。
/// 来源实测为 <c>about:blank</c>（见 fix-wave-A-report.md），只接受该源（允许 fragment），绝不接受远程来源。
/// </summary>
public class WebViewSecurityPolicyTests
{
    [Theory]
    [InlineData("about:blank")]
    [InlineData("about:blank#anchor")]
    [InlineData("ABOUT:BLANK")]
    [InlineData(" about:blank ")]
    public void Trusted_message_source_is_the_app_document(string source)
    {
        Assert.True(WebViewSecurityPolicy.IsTrustedMessageSource(source));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("https://evil.example/")]
    [InlineData("https://md.local/")]
    [InlineData("about:blank.evil")]
    [InlineData("about:blank/extra")]
    [InlineData("file:///C:/notes/a.md")]
    [InlineData("data:text/html,<h1>x</h1>")]
    public void Message_source_rejects_anything_else(string? source)
    {
        Assert.False(WebViewSecurityPolicy.IsTrustedMessageSource(source), source);
    }

    [Fact]
    public void Initial_navigation_is_allowed()
    {
        Assert.True(WebViewSecurityPolicy.IsAllowedNavigation("about:blank", null, isInitialNavigation: true));
        Assert.True(WebViewSecurityPolicy.IsAllowedNavigation("https://evil.example/", "about:blank", isInitialNavigation: true));
    }

    [Theory]
    [InlineData("about:blank#heading", "about:blank", true)]
    [InlineData("about:blank#heading", "about:blank#old", true)]
    [InlineData("ABOUT:BLANK#x", "about:blank", true)]
    [InlineData("about:blank", "about:blank", false)]
    [InlineData("https://evil.example/", "about:blank", false)]
    [InlineData("https://evil.example/#x", "about:blank", false)]
    [InlineData("about:blank#x", "https://evil.example/", false)]
    [InlineData("", "about:blank", false)]
    [InlineData("about:blank#x", null, false)]
    public void Only_same_document_fragment_navigation_is_allowed_after_initial_load(
        string target,
        string? current,
        bool expected)
    {
        Assert.Equal(expected, WebViewSecurityPolicy.IsAllowedNavigation(target, current, isInitialNavigation: false));
    }

    [Theory]
    [InlineData("https://example.com/a", true)]
    [InlineData("HTTPS://EXAMPLE.COM/a", true)]
    [InlineData("http://example.com", true)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///C:/a.md", false)]
    [InlineData("about:blank", false)]
    [InlineData("not a uri", false)]
    [InlineData(null, false)]
    public void TryGetHttpUri_only_accepts_http_and_https(string? uri, bool expected)
    {
        Assert.Equal(expected, WebViewSecurityPolicy.TryGetHttpUri(uri, out var parsed));
        Assert.Equal(expected, parsed is not null);
    }
}
