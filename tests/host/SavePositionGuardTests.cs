using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// M3：savePosition 只接受当前文档的 key。换文档时旧跟踪器迟到的 flush 不能把旧 key
/// 配到新文档路径上（否则 positions.json 会记错 path）。
/// </summary>
public class SavePositionGuardTests
{
    [Theory]
    [InlineData("abc123", "abc123", true)]
    [InlineData("ABC123", "abc123", true)]
    [InlineData("old-key", "new-key", false)]
    [InlineData("", "abc123", false)]
    [InlineData("   ", "abc123", false)]
    [InlineData(null, "abc123", false)]
    public void Only_current_document_key_is_accepted(string? messageKey, string currentKey, bool expected)
    {
        Assert.Equal(expected, MainWindow.IsCurrentDocumentKey(messageKey, currentKey));
    }
}
