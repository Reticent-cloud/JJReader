using System.Text;

namespace JingjingReader;

/// <summary>
/// Task 16：关于面板的纯文本格式（产品/版本/.NET/WebView2/OS + 数据目录 + .md 关联状态）。
/// 纯函数便于单测；窗口只负责把文本放进 TextBox 与提供按钮。
/// </summary>
public static class AboutInfo
{
    /// <summary>产品名（Global Constraints：鲸鲸阅读器）。</summary>
    public const string ProductName = "鲸鲸阅读器";

    /// <summary>固定顺序的多行环境信息：首行「产品名 版本」，随后 .NET / WebView2 / OS。</summary>
    public static string Format(string product, string version, string dotnet, string webview2, string osVersion)
    {
        ArgumentNullException.ThrowIfNull(product);
        ArgumentNullException.ThrowIfNull(version);
        ArgumentNullException.ThrowIfNull(dotnet);
        ArgumentNullException.ThrowIfNull(webview2);
        ArgumentNullException.ThrowIfNull(osVersion);

        var builder = new StringBuilder();
        builder.AppendLine($"{product} {version}");
        builder.AppendLine($".NET: {dotnet}");
        // 文案按 brief 的断言原样使用「WebView2 <版本>」（无冒号），与 .NET/OS 行保持一致的键名可读性。
        builder.AppendLine($"WebView2 {webview2}");
        builder.AppendLine($"OS: {osVersion}");
        return builder.ToString().TrimEnd();
    }

    /// <summary>
    /// AssemblyName.Version（csproj Version 0.1.0 → 0.1.0.0）转显示版本：
    /// 去掉为 0 的 Revision，保留 Build（0.1.0.0 → "0.1.0"；1.2.3.4 原样）。
    /// </summary>
    public static string FormatVersion(Version? version)
    {
        if (version is null)
        {
            return "未知";
        }

        if (version.Build < 0)
        {
            return $"{version.Major}.{version.Minor}";
        }

        return version.Revision > 0
            ? version.ToString()
            : $"{version.Major}.{version.Minor}.{version.Build}";
    }

    /// <summary>.md 关联状态的中文说明（未注册 / 已注册但未设默认 / 已是默认）。</summary>
    public static string AssocText(bool registered, bool isDefault)
    {
        if (!registered)
        {
            return ".md 关联：未注册";
        }

        return isDefault
            ? ".md 关联：已注册，已是默认 .md 程序"
            : ".md 关联：已注册，未设为默认 .md 程序";
    }

    /// <summary>关于面板/「复制诊断信息」共用的完整文本（环境信息 + 数据目录 + 关联状态）。</summary>
    public static string BuildText(
        string version,
        string dotnet,
        string webview2,
        string osVersion,
        string dataDir,
        bool registered,
        bool isDefault)
    {
        ArgumentNullException.ThrowIfNull(dataDir);

        var builder = new StringBuilder();
        builder.AppendLine(Format(ProductName, version, dotnet, webview2, osVersion));
        builder.AppendLine($"数据目录: {dataDir}");
        builder.Append(AssocText(registered, isDefault));
        return builder.ToString();
    }
}
