using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// RecentPolicy：哪些文件读取结果可以进入最近列表。
/// 契约（Task 12 裁定 4）：只有可渲染的文本文档才记录；<c>encoding=binary</c> 的文件拒绝渲染，
/// 也不进最近列表（recent.json 与前端列表都保持不变）。
/// </summary>
public class RecentPolicyTests
{
    private static DocumentRead Document(string encodingName) =>
        new(
            Path: @"C:\notes\a.md",
            Text: encodingName == "binary" ? string.Empty : "正文",
            EncodingName: encodingName,
            HadBom: false,
            Size: 12,
            LastWriteUtc: DateTime.UnixEpoch,
            Key: "key");

    [Theory]
    [InlineData("utf-8")]
    [InlineData("utf-16le")]
    [InlineData("utf-16be")]
    [InlineData("gb18030")]
    [InlineData("")]
    public void ShouldRecord_accepts_renderable_text_encodings(string encodingName)
    {
        Assert.True(RecentPolicy.ShouldRecord(Document(encodingName)));
    }

    [Theory]
    [InlineData("binary")]
    [InlineData("BINARY")]
    public void ShouldRecord_rejects_binary_documents(string encodingName)
    {
        // 二进制文件被拒绝渲染：点击最近项只会再次弹拒绝提示，因此不该出现在最近列表里。
        Assert.False(RecentPolicy.ShouldRecord(Document(encodingName)));
    }

    [Fact]
    public void ShouldRecord_throws_on_null_document()
    {
        Assert.Throws<ArgumentNullException>(() => RecentPolicy.ShouldRecord(null!));
    }
}
