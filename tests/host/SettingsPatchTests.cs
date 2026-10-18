using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// SettingsPatch：saveSettings{patch} 的纯合并逻辑。
/// 契约（Task 12）：只合并已知字段；未知字段、类型不符的字段一律忽略；空 patch / null / 坏 JSON 返回原设置。
/// </summary>
public class SettingsPatchTests
{
    [Fact]
    public void Apply_merges_known_fields()
    {
        var current = new AppSettings();

        var merged = SettingsPatch.Apply(
            current,
            """{"theme":"dark","fontSize":20,"lineHeight":1.9,"contentWidth":640,"cjkFont":"Microsoft YaHei","monoFont":"Cascadia Mono","tocVisible":false,"tocWidth":300,"uiStyle":"whale"}""");

        Assert.Equal("dark", merged.Theme);
        Assert.Equal(20, merged.FontSize);
        Assert.Equal(1.9, merged.LineHeight);
        Assert.Equal(640, merged.ContentWidth);
        Assert.Equal("Microsoft YaHei", merged.CjkFont);
        Assert.Equal("Cascadia Mono", merged.MonoFont);
        Assert.False(merged.TocVisible);
        Assert.Equal(300, merged.TocWidth);
        Assert.Equal("whale", merged.UiStyle); // 界面美化波：uiStyle 参与 patch 合并
    }

    [Fact]
    public void Apply_keeps_fields_missing_from_patch()
    {
        var current = new AppSettings(
            Theme: "light",
            FontSize: 22,
            LineHeight: 1.5,
            ContentWidth: 960,
            CjkFont: "Source Han Sans SC",
            TocVisible: false,
            TocWidth: 320,
            MonoFont: "Cascadia Mono");

        var merged = SettingsPatch.Apply(current, """{"fontSize":18}""");

        Assert.Equal("light", merged.Theme);
        Assert.Equal(18, merged.FontSize);
        Assert.Equal(1.5, merged.LineHeight);
        Assert.Equal(960, merged.ContentWidth);
        Assert.Equal("Source Han Sans SC", merged.CjkFont);
        Assert.False(merged.TocVisible);
        Assert.Equal(320, merged.TocWidth);
        Assert.Equal("Cascadia Mono", merged.MonoFont);
    }

    [Fact]
    public void Apply_merges_ui_style_and_keeps_it_when_patch_omits_it()
    {
        // 界面美化波：whale 合并成功；后续只改字号的 patch 不能把风格重置回 reader。
        var current = new AppSettings();
        var switched = SettingsPatch.Apply(current, """{"uiStyle":"whale"}""");
        Assert.Equal("whale", switched.UiStyle);

        var afterFont = SettingsPatch.Apply(switched, """{"fontSize":18}""");
        Assert.Equal(18, afterFont.FontSize);
        Assert.Equal("whale", afterFont.UiStyle);

        // 宿主不做白名单校验（前端负责未知值回退 reader），字符串值原样透传。
        var unknown = SettingsPatch.Apply(current, """{"uiStyle":"future-style"}""");
        Assert.Equal("future-style", unknown.UiStyle);
    }

    [Fact]
    public void Apply_ignores_unknown_fields()
    {
        var current = new AppSettings();

        var merged = SettingsPatch.Apply(current, """{"bogus":123,"nested":{"fontSize":30},"window":{"x":1}}""");

        Assert.Equal(current, merged);
    }

    [Theory]
    [InlineData("""{"fontSize":"18"}""")]
    [InlineData("""{"fontSize":true}""")]
    [InlineData("""{"fontSize":null}""")]
    [InlineData("""{"lineHeight":"1.9"}""")]
    [InlineData("""{"tocVisible":"false"}""")]
    [InlineData("""{"tocVisible":0}""")]
    [InlineData("""{"theme":5}""")]
    [InlineData("""{"theme":null}""")]
    [InlineData("""{"cjkFont":[]}""")]
    [InlineData("""{"monoFont":{}}""")]
    [InlineData("""{"uiStyle":5}""")]
    [InlineData("""{"uiStyle":null}""")]
    [InlineData("""{"uiStyle":[]}""")]
    [InlineData("""{"tocWidth":"240"}""")]
    [InlineData("""{"contentWidth":1.5}""")]
    public void Apply_ignores_type_mismatched_fields(string patchJson)
    {
        var current = new AppSettings(FontSize: 17, Theme: "dark");

        var merged = SettingsPatch.Apply(current, patchJson);

        Assert.Equal(current, merged);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("null")]
    public void Apply_returns_current_for_empty_or_invalid_patch(string? patchJson)
    {
        var current = new AppSettings(FontSize: 19);

        var merged = SettingsPatch.Apply(current, patchJson);

        Assert.Same(current, merged);
    }

    [Fact]
    public void Apply_preserves_window_geometry()
    {
        var current = new AppSettings(Window: new WindowGeometry(X: 10, Y: 20, W: 900, H: 700, Max: true));

        var merged = SettingsPatch.Apply(current, """{"fontSize":18}""");

        Assert.Equal(new WindowGeometry(X: 10, Y: 20, W: 900, H: 700, Max: true), merged.Window);
    }

    [Fact]
    public void Apply_accepts_integral_line_height()
    {
        var current = new AppSettings();

        var merged = SettingsPatch.Apply(current, """{"lineHeight":2}""");

        Assert.Equal(2d, merged.LineHeight);
    }

    [Fact]
    public void Apply_rejects_null_current()
    {
        Assert.Throws<ArgumentNullException>(() => SettingsPatch.Apply(null!, """{"fontSize":18}"""));
    }
}
