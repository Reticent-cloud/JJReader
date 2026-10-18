namespace JingjingReader;

/// <summary>
/// WebView2 导航与消息来源策略（评审 C2）：页面由 <c>NavigateToString</c> 装载，
/// 文档源固定为 <c>about:blank</c>。只放行初始装载与同文档 <c>#fragment</c> 跳转；
/// 只接受该源的 <c>chrome.webview</c> 消息。其余一律拦截/丢弃，避免 .md 内容把 WebView 导航到
/// 远程页面后继承宿主注入的 <c>chrome.webview</c> 通道。
/// </summary>
public static class WebViewSecurityPolicy
{
    /// <summary>NavigateToString 页面的文档源（实测值，见 fix-wave-A-report.md）。</summary>
    public const string DocumentSource = "about:blank";

    /// <summary>
    /// 消息来源是否可信：只接受应用文档的源（<see cref="DocumentSource"/>，可带 fragment）。
    /// 空值/远程来源一律不可信；绝不接受任意来源。
    /// </summary>
    public static bool IsTrustedMessageSource(string? source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return false;
        }

        return string.Equals(StripFragment(source.Trim()), DocumentSource, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 是否放行一次 WebView 导航：初始 <c>NavigateToString</c> 放行；之后只放行同文档 <c>#fragment</c>
    /// 跳转（目标去掉 fragment 后与当前文档 URL 去掉 fragment 相等）。其余导航全部应取消。
    /// </summary>
    public static bool IsAllowedNavigation(string? targetUri, string? currentDocumentUri, bool isInitialNavigation)
    {
        if (isInitialNavigation)
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(targetUri) || string.IsNullOrWhiteSpace(currentDocumentUri))
        {
            return false;
        }

        // 没有 # 的目标是整页导航（含 about:blank 重新装载），不是同文档锚点。
        var hashIndex = targetUri.IndexOf('#');
        if (hashIndex < 0)
        {
            return false;
        }

        var targetBase = targetUri[..hashIndex];
        var currentBase = StripFragment(currentDocumentUri);
        return string.Equals(targetBase, currentBase, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>解析 http(s) 绝对 URI（外链交给系统浏览器用）；其它协议/非法 URI 返回 false。</summary>
    public static bool TryGetHttpUri(string? uriText, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(uriText) || !Uri.TryCreate(uriText, UriKind.Absolute, out var parsed))
        {
            return false;
        }

        if (!string.Equals(parsed.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        uri = parsed;
        return true;
    }

    private static string StripFragment(string uri)
    {
        var hashIndex = uri.IndexOf('#');
        return hashIndex < 0 ? uri : uri[..hashIndex];
    }
}
