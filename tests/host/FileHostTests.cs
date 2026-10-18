using System.IO;
using System.Text;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// FileHost：路径规范化、扩展名判断、编码探测、文档读取、虚拟主机 URL 与目录穿越防护。
/// 全部用例只做纯路径计算或真实临时文件读写（TestHelpers.TestDir），不 mock 文件系统。
/// </summary>
public class FileHostTests
{
    private const string BaseUrl = "https://md.local/";

    // ---------------- NormalizePath ----------------

    [Fact]
    public void NormalizePath_trims_whitespace_and_quotes()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "a.md");

        // 命令行 / 资源管理器粘贴来的路径可能带首尾空白与成对引号
        Assert.Equal(path, FileHost.NormalizePath("  \"" + path + "\"  "));
    }

    [Fact]
    public void NormalizePath_resolves_relative_against_cwd_and_unifies_separators()
    {
        var expected = Path.Combine(Directory.GetCurrentDirectory(), "sub", "a.md");

        var normalized = FileHost.NormalizePath("./sub/a.md");

        Assert.True(Path.IsPathFullyQualified(normalized));
        Assert.Equal(expected, normalized);
    }

    [Fact]
    public void NormalizePath_uppercases_drive_letter_only()
    {
        // Path.GetFullPath 本身保留输入里盘符的大小写，必须由 NormalizePath 统一成大写盘符
        Assert.Equal(@"C:\notes\a.md", FileHost.NormalizePath(@"c:\notes\a.md"));
        // 除盘符外的大小写保持用户原样（Windows 路径大小写不敏感，但不做无谓改写）
        Assert.Equal(@"C:\Notes\ReadMe.MD", FileHost.NormalizePath(@"C:\Notes\ReadMe.MD"));
    }

    [Fact]
    public void NormalizePath_keeps_short_path_without_extended_prefix()
    {
        Assert.Equal(@"C:\notes\a.md", FileHost.NormalizePath(@"C:\notes\a.md"));
    }

    [Fact]
    public void NormalizePath_adds_extended_prefix_for_long_path()
    {
        var longPath = @"C:\" + new string('a', 250) + @"\a.md"; // 258 字符 > 255

        var normalized = FileHost.NormalizePath(longPath);

        Assert.StartsWith(@"\\?\C:\", normalized);
        Assert.EndsWith(@"\a.md", normalized);
        Assert.Equal(longPath.Length + @"\\?\".Length, normalized.Length);
        // 已是扩展路径时必须幂等，不能叠成 \\?\\\?\...
        Assert.Equal(normalized, FileHost.NormalizePath(normalized));
    }

    [Fact]
    public void NormalizePath_handles_unc_path_with_extended_unc_prefix()
    {
        // \\?\ 前缀要求绝对且已规范化；UNC 的等价形式是 \\?\UNC\server\share\...
        var normalized = FileHost.NormalizePath(@"\\server\share\docs\a.md");

        Assert.Equal(@"\\?\UNC\server\share\docs\a.md", normalized);
        Assert.Equal(normalized, FileHost.NormalizePath(normalized));
    }

    [Fact]
    public void NormalizePath_rejects_blank_input()
    {
        Assert.Throws<ArgumentNullException>(() => FileHost.NormalizePath(null!));
        Assert.Throws<ArgumentException>(() => FileHost.NormalizePath(""));
        Assert.Throws<ArgumentException>(() => FileHost.NormalizePath("   "));
    }

    // ---------------- IsMarkdown ----------------

    [Theory]
    [InlineData(@"C:\notes\a.md", true)]
    [InlineData(@"C:\notes\a.markdown", true)]
    [InlineData(@"C:\notes\a.mdown", true)]
    [InlineData(@"C:\notes\a.txt", true)]
    [InlineData(@"C:\notes\A.MD", true)]
    [InlineData(@"C:\notes\a.TXT", true)]
    [InlineData(@"C:\notes\中文 目录#1\标题.MarkDown", true)]
    [InlineData(@"C:\notes\a.mdx", false)]
    [InlineData(@"C:\notes\a.html", false)]
    [InlineData(@"C:\notes\a.png", false)]
    [InlineData(@"C:\notes\a", false)]
    [InlineData("", false)]
    public void IsMarkdown_recognizes_four_extensions_case_insensitive(string path, bool expected)
    {
        Assert.Equal(expected, FileHost.IsMarkdown(path));
    }

    // ---------------- Decode ----------------

    [Fact]
    public void Decode_utf8_bom()
    {
        var result = FileHost.Decode(new byte[] { 0xEF, 0xBB, 0xBF, (byte)'a' });

        Assert.Equal("a", result.Text);
        Assert.Equal("utf-8", result.EncodingName);
        Assert.True(result.HadBom);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_utf8_without_bom()
    {
        var result = FileHost.Decode(Encoding.UTF8.GetBytes("中文"));

        Assert.Equal("中文", result.Text);
        Assert.Equal("utf-8", result.EncodingName);
        Assert.False(result.HadBom);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_utf16le_bom_wins_over_nul_bytes()
    {
        // UTF-16LE 文本必然含 NUL 字节，但 BOM 优先于「含 \0 即二进制」的判断
        var bytes = new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes("中文")).ToArray();

        var result = FileHost.Decode(bytes);

        Assert.Equal("中文", result.Text);
        Assert.Equal("utf-16le", result.EncodingName);
        Assert.True(result.HadBom);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_utf16be_bom()
    {
        var bytes = new byte[] { 0xFE, 0xFF }.Concat(Encoding.BigEndianUnicode.GetBytes("中文")).ToArray();

        var result = FileHost.Decode(bytes);

        Assert.Equal("中文", result.Text);
        Assert.Equal("utf-16be", result.EncodingName);
        Assert.True(result.HadBom);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_gb18030_when_strict_utf8_fails()
    {
        // 先触碰 FileHost（静态构造里注册 CodePages provider），再直接取 GB18030 编码器生成字节。
        // 若实现漏了 provider 注册，这里的 Encoding.GetEncoding 会抛 NotSupportedException（RED）。
        Assert.True(FileHost.Decode(new byte[] { 0xEF, 0xBB, 0xBF, (byte)'a' }).HadBom);

        var result = FileHost.Decode(Encoding.GetEncoding("GB18030").GetBytes("中文"));

        Assert.Equal("中文", result.Text);
        Assert.Equal("gb18030", result.EncodingName);
        Assert.False(result.HadBom);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_gb18030_literal_bytes()
    {
        // GB18030/GBK 的「中文」字节；不依赖测试进程里的 CodePages provider
        var result = FileHost.Decode(new byte[] { 0xD6, 0xD0, 0xCE, 0xC4 });

        Assert.Equal("中文", result.Text);
        Assert.Equal("gb18030", result.EncodingName);
        Assert.False(result.IsBinary);
    }

    [Fact]
    public void Decode_binary_when_contains_nul()
    {
        Assert.True(FileHost.Decode(new byte[] { 0x00, 0x01, 0x02 }).IsBinary);
        Assert.True(FileHost.Decode(new byte[] { (byte)'a', 0x00, (byte)'b' }).IsBinary);
    }

    [Fact]
    public void Decode_empty_bytes_is_empty_text_not_binary()
    {
        var result = FileHost.Decode([]);

        Assert.Equal("", result.Text);
        Assert.False(result.IsBinary);
        Assert.False(result.HadBom);
    }

    // ---------------- VirtualHostUrl ----------------

    [Theory]
    [InlineData(@"C:\notes\中文 目录#1\a.md")]
    [InlineData(@"C:\notes\a.md")]
    public void VirtualHostUrl_escapes_chinese_space_and_hash(string doc)
    {
        var url = FileHost.VirtualHostUrl(doc, "img/图 1.png");

        Assert.Equal(BaseUrl + "img/%E5%9B%BE%201.png", url);
    }

    [Fact]
    public void VirtualHostUrl_decodes_percent_encoded_reference_then_escapes_segments()
    {
        // CommonMark 里 img/a%20b.png 表示文件名「a b.png」：引用先解码一次，再逐段转义；
        // 解码后的字面 # 仍要转义成 %23，但空格不能被二次编码成 %2520。
        var expected = BaseUrl + "img/a%20b%23c.png";

        Assert.Equal(expected, FileHost.VirtualHostUrl(@"C:\notes\a.md", "img/a%20b#c.png"));
        Assert.Equal(expected, FileHost.VirtualHostUrl(@"C:\notes\a.md", @"img\a%20b#c.png"));
    }

    [Fact]
    public void VirtualHostUrl_decodes_percent_encoded_chinese_reference()
    {
        Assert.Equal(
            BaseUrl + "img/%E5%9B%BE%201.png",
            FileHost.VirtualHostUrl(@"C:\notes\a.md", "img/图%201.png"));
    }

    [Fact]
    public void VirtualHostUrl_escapes_literal_percent_and_keeps_invalid_escape_sequences()
    {
        // 字面 % 只转义一次成 %25；无法解析的转义序列（100%、%zz）保持原样，不抛异常
        Assert.Equal(BaseUrl + "img/100%25.png", FileHost.VirtualHostUrl(@"C:\notes\a.md", "img/100%.png"));
        Assert.Equal(BaseUrl + "img/a%25zz.png", FileHost.VirtualHostUrl(@"C:\notes\a.md", "img/a%zz.png"));
    }

    [Fact]
    public void VirtualHostUrl_absolute_target_inside_doc_dir_becomes_relative()
    {
        Assert.Equal(
            BaseUrl + "img/x.png",
            FileHost.VirtualHostUrl(@"C:\notes\a.md", @"C:\notes\img\x.png"));
    }

    [Fact]
    public void VirtualHostUrl_null_empty_or_dot_is_base_url()
    {
        Assert.Equal(BaseUrl, FileHost.VirtualHostUrl(@"C:\notes\a.md", null));
        Assert.Equal(BaseUrl, FileHost.VirtualHostUrl(@"C:\notes\a.md", ""));
        Assert.Equal(BaseUrl, FileHost.VirtualHostUrl(@"C:\notes\a.md", "."));
    }

    [Fact]
    public void VirtualHostUrl_traversal_falls_back_to_escaped_reference_without_throwing()
    {
        // 越出文档目录时不抛异常：仍落在 md.local 虚拟主机上，交给前端图片占位框兜底
        Assert.Equal(
            BaseUrl + "../secret/%E5%9B%BE.png",
            FileHost.VirtualHostUrl(@"C:\notes\a.md", @"..\secret\图.png"));

        // 跨盘绝对路径同样换算不成相对路径，按原始引用转义
        Assert.Equal(
            BaseUrl + "D%3A/pics/x.png",
            FileHost.VirtualHostUrl(@"C:\notes\a.md", @"D:\pics\x.png"));
    }

    [Fact]
    public void VirtualHostUrl_traversal_with_percent_encoded_reference_falls_back_once_escaped()
    {
        // 越界兜底分支同样「先解码再逐段转义」：%20 保持单段转义，不出现 %2520，且绝不抛异常
        var url = FileHost.VirtualHostUrl(@"C:\notes\a.md", @"..\..\secret%20dir\a.png");

        Assert.StartsWith(BaseUrl, url);
        Assert.Contains("secret%20dir/a.png", url);
        Assert.DoesNotContain("%2520", url);
    }

    // ---------------- ResolveInside ----------------

    [Fact]
    public void ResolveInside_rejects_traversal()
    {
        Assert.Null(FileHost.ResolveInside(@"C:\notes", @"..\..\windows\win.ini"));
        Assert.NotNull(FileHost.ResolveInside(@"C:\notes", @"sub\a.png"));
    }

    [Fact]
    public void ResolveInside_returns_normalized_path_for_inside_reference()
    {
        Assert.Equal(@"C:\notes\sub\a.png", FileHost.ResolveInside(@"C:\notes", @"sub\a.png"));
        Assert.Equal(@"C:\notes\sub\a.png", FileHost.ResolveInside(@"C:\notes\", @"sub\a.png"));
        // .. 抵消后仍在目录内 → 收起来继续允许
        Assert.Equal(@"C:\notes\a.png", FileHost.ResolveInside(@"C:\notes", @"sub\..\a.png"));
    }

    [Fact]
    public void ResolveInside_validates_absolute_reference()
    {
        Assert.Null(FileHost.ResolveInside(@"C:\notes", @"C:\Windows\win.ini"));
        Assert.Null(FileHost.ResolveInside(@"C:\notes", @"D:\notes\a.png"));
        Assert.Equal(
            @"C:\notes\sub\a.png",
            FileHost.ResolveInside(@"C:\notes", @"C:\notes\sub\a.png"));
    }

    [Fact]
    public void ResolveInside_rejects_sibling_directory_prefix()
    {
        // 严格前缀（docDir + \），C:\notes2 不是 C:\notes 的子目录
        Assert.Null(FileHost.ResolveInside(@"C:\notes", @"C:\notes2\a.png"));
    }

    [Fact]
    public void ResolveInside_handles_blank_and_malformed_reference()
    {
        Assert.Null(FileHost.ResolveInside(@"C:\notes", ""));
        Assert.Null(FileHost.ResolveInside(@"C:\notes", "   "));
        Assert.Null(FileHost.ResolveInside(@"C:\notes", "bad\u0000name.png"));
    }

    [Fact]
    public void ResolveInside_rejects_traversal_for_long_or_unc_doc_dir()
    {
        // docDir 已带 \\?\ / \\?\UNC 前缀时，.. 不会被 Path.GetFullPath 展开；
        // 实现必须先还原普通绝对路径再比较，否则 "..\..\windows\win.ini" 会被前缀误判为「在目录内」。
        var longDir = FileHost.NormalizePath(@"C:\" + new string('a', 260)); // 263 字符 → 带 \\?\ 前缀
        Assert.StartsWith(@"\\?\", longDir);
        Assert.Null(FileHost.ResolveInside(longDir, @"..\..\windows\win.ini"));
        Assert.NotNull(FileHost.ResolveInside(longDir, @"sub\a.png"));

        Assert.Null(FileHost.ResolveInside(@"\\server\share\notes", @"..\..\windows\win.ini"));
        Assert.NotNull(FileHost.ResolveInside(@"\\server\share\notes", @"sub\a.png"));
    }

    // ---------------- ReadDocument ----------------

    [Fact]
    public void ReadDocument_builds_key_and_metadata()
    {
        var file = Path.Combine(TestHelpers.TestDir(), "文档 #1.md");
        File.WriteAllText(file, "# 标题\n正文", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        var document = FileHost.ReadDocument(file);

        Assert.Equal(FileHost.NormalizePath(file), document.Path);
        Assert.Equal("# 标题\n正文", document.Text);
        Assert.Equal("utf-8", document.EncodingName);
        Assert.False(document.HadBom);
        Assert.Equal(new FileInfo(file).Length, document.Size);
        Assert.True(document.Size > 0);
        Assert.Equal(File.GetLastWriteTimeUtc(file), document.LastWriteUtc);
        Assert.Equal(
            Store.ComputeKey(document.Path, document.Size, document.LastWriteUtc),
            document.Key);
        Assert.Equal(40, document.Key.Length);
        // 文件未变 → key 稳定
        Assert.Equal(document.Key, FileHost.ReadDocument(file).Key);
    }

    [Fact]
    public void ReadDocument_reads_gb18030_file()
    {
        var file = Path.Combine(TestHelpers.TestDir(), "gb18030.md");
        File.WriteAllBytes(file, new byte[] { 0xD6, 0xD0, 0xCE, 0xC4 }); // GB18030「中文」

        var document = FileHost.ReadDocument(file);

        Assert.Equal("中文", document.Text);
        Assert.Equal("gb18030", document.EncodingName);
    }

    [Fact]
    public void ReadDocument_binary_file_is_flagged_not_thrown()
    {
        var file = Path.Combine(TestHelpers.TestDir(), "blob.bin");
        File.WriteAllBytes(file, new byte[] { 0x01, 0x02, 0x00, 0x03 });

        var document = FileHost.ReadDocument(file);

        // IsBinary 时原样返回（EncodingName == "binary"、Text 为空），由调用方决定拒绝渲染
        Assert.Equal("binary", document.EncodingName);
        Assert.Equal("", document.Text);
        Assert.Equal(4, document.Size);
        Assert.NotEmpty(document.Key);
    }

    [Fact]
    public void ReadDocument_missing_file_throws_standard_exception()
    {
        var missing = Path.Combine(TestHelpers.TestDir(), "nope.md");

        Assert.Throws<FileNotFoundException>(() => FileHost.ReadDocument(missing));
    }

    // ---------------- 大文件上限（M11） ----------------

    [Fact]
    public void IsTooLarge_allows_exactly_50_mb_and_rejects_more()
    {
        Assert.Equal(50L * 1024 * 1024, FileHost.MaxDocumentBytes);
        Assert.False(FileHost.IsTooLarge(0));
        Assert.False(FileHost.IsTooLarge(FileHost.MaxDocumentBytes));
        Assert.True(FileHost.IsTooLarge(FileHost.MaxDocumentBytes + 1));
    }
}
