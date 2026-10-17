using System.Text;
using Microsoft.Win32;

namespace JingjingReader;

/// <summary>环境自检：采集产品名、.NET、WebView2 运行时与操作系统版本，拼成多行文本。</summary>
public static class SelfTest
{
    private const string ProductName = "鲸鲸阅读器";

    /// <summary>WebView2 Runtime 在 EdgeUpdate 客户端列表中的 GUID（32 位注册表视图）。</summary>
    private const string WebView2ClientKey =
        @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    /// <summary>采集真实环境信息；任何一项读取失败都不抛异常（WebView2 缺失时写「未检测到」）。</summary>
    public static string Run()
    {
        var dotnetVersion = Environment.Version.ToString();
        var webview2Version = TryReadWebView2Version() ?? "未检测到";
        var osVersion = Environment.OSVersion.Version.ToString();
        return Format(ProductName, dotnetVersion, webview2Version, osVersion);
    }

    /// <summary>按固定顺序拼接 4 个键：产品名、.NET、WebView2、OS。</summary>
    public static string Format(string productName, string dotnetVersion, string webview2Version, string osVersion)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"产品名: {productName}");
        builder.AppendLine($".NET: {dotnetVersion}");
        builder.AppendLine($"WebView2: {webview2Version}");
        builder.AppendLine($"OS: {osVersion}");
        return builder.ToString().TrimEnd();
    }

    private static string? TryReadWebView2Version()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(WebView2ClientKey);
            var version = key?.GetValue("pv") as string;
            return string.IsNullOrWhiteSpace(version) ? null : version;
        }
        catch (Exception)
        {
            // 键不存在、无权读取或注册表访问被拒：都按「未检测到」处理。
            return null;
        }
    }
}
