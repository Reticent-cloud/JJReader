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
            """{"theme":"dark","fontSize":20,"lineHeight":1.9,"contentWidth":640,"cjkFont":"Microsoft YaHei","monoFont":"Cascadia Mono","tocVisible":false,"tocWidth":300,"palette":"default"}""");

        Assert.Equal("dark", merged.Theme);
        Assert.Equal(20, merged.FontSize);
        Assert.Equal(1.9, merged.LineHeight);
        Assert.Equal(640, merged.ContentWidth);
        Assert.Equal("Microsoft YaHei", merged.CjkFont);
        Assert.Equal("Cascadia Mono", merged.MonoFont);
        Assert.False(merged.TocVisible);
        Assert.Equal(300, merged.TocWidth);
        Assert.Equal("default", merged.Palette);
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
            MonoFont: "Cascadia Mono",
            Palette: "default");

        var merged = SettingsPatch.Apply(current, """{"fontSize":18}""");

        Assert.Equal("light", merged.Theme);
        Assert.Equal(18, merged.FontSize);
        Assert.Equal(1.5, merged.LineHeight);
        Assert.Equal(960, merged.ContentWidth);
        Assert.Equal("Source Han Sans SC", merged.CjkFont);
        Assert.False(merged.TocVisible);
        Assert.Equal(320, merged.TocWidth);
        Assert.Equal("Cascadia Mono", merged.MonoFont);
        Assert.Equal("default", merged.Palette);
    }

    [Fact]
    public void Apply_accepts_palette_blue()
    {
        var current = new AppSettings(Palette: "default");

        var merged = SettingsPatch.Apply(current, """{"palette":"blue"}""");

        Assert.Equal("blue", merged.Palette);
    }

    [Theory]
    [InlineData("""{"palette":"ocean"}""")]
    [InlineData("""{"palette":"Blue"}""")]
    [InlineData("""{"palette":""}""")]
    public void Apply_ignores_invalid_palette_value_and_keeps_default_blue(string patchJson)
    {
        // 非法配色不写坏设置：默认设置保持 blue（前端 normalizePalette 对非法值同样回落 blue）。
        var current = new AppSettings();

        var merged = SettingsPatch.Apply(current, patchJson);

        Assert.Equal("blue", merged.Palette);
    }

    [Fact]
    public void Apply_ignores_legacy_ui_style_field()
    {
        // whale 主题已删除：旧前端/旧 settings 里的 uiStyle 不再参与合并，也不影响其它字段。
        var current = new AppSettings(FontSize: 18);
        var merged = SettingsPatch.Apply(current, """{"uiStyle":"whale"}""");

        Assert.Equal(current, merged);
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
    [InlineData("""{"palette":5}""")]
    [InlineData("""{"palette":null}""")]
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
