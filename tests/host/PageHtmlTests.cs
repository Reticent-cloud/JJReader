using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// M10：内联引擎脚本的 HTML 解析等价转义。除 <c>&lt;/script</c> 外，
/// <c>&lt;script</c> 与 <c>&lt;!--</c> 也要转义，避免产物里的片段提前结束/开启脚本/注释导致空白窗口。
/// </summary>
public class PageHtmlTests
{
    [Fact]
    public void EscapeScriptContent_escapes_script_close_open_and_comment()
    {
        var escaped = MainWindow.EscapeScriptContent("</script><script><!--x-->");

        Assert.Equal("<\\/script><\\script><\\!--x-->", escaped);
        Assert.DoesNotContain("</script", escaped, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<script", escaped, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<!--", escaped, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapeScriptContent_is_case_insensitive_and_idempotent()
    {
        var escaped = MainWindow.EscapeScriptContent("</SCRIPT><Script><!--");

        // 大小写不敏感匹配；输出为同一套小写转义片段（HTML 标签名本就大小写不敏感）。
        Assert.Equal("<\\/script><\\script><\\!--", escaped);
        // 已转义的片段不会再命中（不会出现 <\\/script 这种 double-escape）
        Assert.Equal(escaped, MainWindow.EscapeScriptContent(escaped));
    }

    [Fact]
    public void EscapeScriptContent_preserves_normal_code()
    {
        const string script = "const html = '<div>' + 'a < b' + '</div>';";

        Assert.Equal(script, MainWindow.EscapeScriptContent(script));
    }
}
