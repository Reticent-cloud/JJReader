using System.IO;
using System.Text;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// §5.11 编码异常检测：严格 UTF-8 与 GB18030 都产生替换字符时 HadReplacement=true，
/// 宿主据此发送持久 notice；正常 UTF-8 / GB18030 / BOM 文档不误报。
/// </summary>
public class FileHostEncodingTests
{
    [Fact]
    public void Valid_utf8_has_no_replacement()
    {
        var (text, encoding, _, isBinary, hadReplacement) = FileHost.Decode(Encoding.UTF8.GetBytes("中文 OK"));

        Assert.Equal("中文 OK", text);
        Assert.Equal("utf-8", encoding);
        Assert.False(isBinary);
        Assert.False(hadReplacement);
    }

    [Fact]
    public void Valid_gb18030_has_no_replacement()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var bytes = Encoding.GetEncoding("GB18030").GetBytes("中文内容");
        var (text, encoding, _, _, hadReplacement) = FileHost.Decode(bytes);

        Assert.Equal("中文内容", text);
        Assert.Equal("gb18030", encoding);
        Assert.False(hadReplacement);
    }

    [Fact]
    public void Invalid_bytes_report_replacement()
    {
        // 0xFF 既不是合法 UTF-8 序列也不能作为 GB18030 首字节：两条路径都会产生 U+FFFD
        var (_, _, _, isBinary, hadReplacement) = FileHost.Decode(new byte[] { 0xFF, 0x41 });

        Assert.False(isBinary);
        Assert.True(hadReplacement);
    }

    [Fact]
    public void Binary_has_no_replacement_flag()
    {
        var (_, encoding, _, isBinary, hadReplacement) = FileHost.Decode(new byte[] { 0x61, 0x00, 0x62 });

        Assert.Equal("binary", encoding);
        Assert.True(isBinary);
        Assert.False(hadReplacement);
    }

    [Fact]
    public void ReadDocument_propagates_replacement_flag()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "bad.md");
        File.WriteAllBytes(path, new byte[] { 0xFF, 0x41 });

        var document = FileHost.ReadDocument(path);

        Assert.True(document.HadReplacement);
    }
}
