namespace JingjingReader;

/// <summary>
/// 最近文件记录策略（Task 12 裁定 4）：只有可渲染的文本文档才进最近列表。
/// 二进制文件（<c>encoding=binary</c>）会被拒绝渲染，点击最近项只会再次弹拒绝提示，
/// 因此读取成功也不记录——recent.json 与前端最近列表都保持原样。
/// </summary>
public static class RecentPolicy
{
    private const string BinaryEncoding = "binary";

    /// <summary>本次读取结果是否应写入最近文件（<c>encoding=binary</c> 不记录）。</summary>
    /// <exception cref="ArgumentNullException"><paramref name="document"/> 为 null。</exception>
    public static bool ShouldRecord(DocumentRead document)
    {
        ArgumentNullException.ThrowIfNull(document);
        return !string.Equals(document.EncodingName, BinaryEncoding, StringComparison.OrdinalIgnoreCase);
    }
}
