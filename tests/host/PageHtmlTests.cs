using System.IO;
using System.Text;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// M10：内联引擎脚本的 HTML 解析等价转义。只转义两种会改变 HTML 解析状态的片段：
/// <c>&lt;/script</c>（提前闭合脚本）与 <c>&lt;!--</c>（进入 double-escaped 状态）。
/// <c>&lt;script</c> 本身不能改写：hljs XML 模式里的 <c>/&lt;script(?=\s|&gt;)/</c> 会被
/// <c>&lt;\script</c> 破坏（<c>\s</c> 变成空白类），导致 <c>&lt;script&gt;</c> 代码块高亮降级。
/// </summary>
public class PageHtmlTests
{
    [Fact]
    public void EscapeScriptContent_escapes_close_tag_and_comment_open_only()
    {
        var escaped = MainWindow.EscapeScriptContent("</script><script><!--x-->");

        Assert.Equal("<\\/script><script><\\!--x-->", escaped);
        Assert.DoesNotContain("</script", escaped, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<!--", escaped, StringComparison.Ordinal);
        // <script> 字面必须原样保留（HTML 解析器在脚本数据态不会因它提前闭合）。
        Assert.Contains("<script>", escaped, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapeScriptContent_is_case_insensitive_for_close_tag_and_idempotent()
    {
        var escaped = MainWindow.EscapeScriptContent("</SCRIPT><Script><!--");

        // 只对 </script 做大小写不敏感匹配；<Script> 不再改写。
        Assert.Equal("<\\/script><Script><\\!--", escaped);
        // 已转义的片段不会再命中（不会出现 <\\/script 这种 double-escape）
        Assert.Equal(escaped, MainWindow.EscapeScriptContent(escaped));
    }

    [Fact]
    public void EscapeScriptContent_preserves_normal_code()
    {
        const string script = "const html = '<div>' + 'a < b' + '</div>';";

        Assert.Equal(script, MainWindow.EscapeScriptContent(script));
    }

    [Fact]
    public void EscapeScriptContent_keeps_regex_source_and_script_literal_verbatim()
    {
        // 模拟 hljs XML 模式与用户代码块：/ 与 ' 都是 JS 代码的一部分，不能被 HTML 转义改写。
        const string source = "const re = /<script(?=\\s|>)/; const html = '<script>';";
        var escaped = MainWindow.EscapeScriptContent(source);

        Assert.Equal(source, escaped);
        Assert.Contains("<script(?=\\s|>)", escaped, StringComparison.Ordinal);
        Assert.Contains("'<script>'", escaped, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapeScriptContent_preserves_script_open_tag_count_of_embedded_bundle()
    {
        var bundle = ReadEmbeddedResource(".md-engine.js");

        var escaped = MainWindow.EscapeScriptContent(bundle);

        // 不逐字改写 <script：bundle 里 <script 的次数必须与原始一致（当前为 hljs XML 正则 1 处）。
        Assert.Equal(CountOccurrences(bundle, "<script"), CountOccurrences(escaped, "<script"));
        Assert.Contains("<script(?=\\s|>)", escaped, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildPageHtml_inlines_engine_without_breaking_html_or_js_source()
    {
        var indexHtml = ReadEmbeddedResource(".index.html");
        var bundle = ReadEmbeddedResource(".md-engine.js");

        var html = MainWindow.BuildPageHtml();

        // <script 次数 = index.html（注释 + 占位标签）+ bundle 原样内联；转义不得增删。
        Assert.Equal(
            CountOccurrences(indexHtml, "<script") + CountOccurrences(bundle, "<script"),
            CountOccurrences(html, "<script"));
        // </script 只来自 index.html（真正的闭合标签与注释文本）；bundle 里的闭合序列已被转义。
        Assert.Equal(CountOccurrences(indexHtml, "</script"), CountOccurrences(html, "</script"));
        // <!-- 只来自 index.html；bundle 里的注释起始必须全部转义为 <\!--。
        Assert.Equal(CountOccurrences(indexHtml, "<!--"), CountOccurrences(html, "<!--"));
        Assert.Contains("<script(?=\\s|>)", html, StringComparison.Ordinal);
        Assert.Contains("<script id=\"md-engine\">", html, StringComparison.Ordinal);
    }

    private static string ReadEmbeddedResource(string nameSuffix)
    {
        var assembly = typeof(MainWindow).Assembly;
        var name = assembly.GetManifestResourceNames()
            .Single(candidate => candidate.EndsWith(nameSuffix, StringComparison.OrdinalIgnoreCase));
        using var stream = assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("缺少嵌入资源：" + nameSuffix);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count += 1;
            index += value.Length;
        }

        return count;
    }
}
