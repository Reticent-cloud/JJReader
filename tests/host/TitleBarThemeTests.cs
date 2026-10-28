using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 自绘标题栏纯逻辑（TitleBarTheme）：palette + 系统明暗 → 色值映射、系统主题解析、标题文案、最大化按钮状态。
/// WPF 交互（拖动/双击/Aero Snap/系统菜单/高 DPI）无法在 xUnit 里可靠模拟，列入手测清单。
/// </summary>
public class TitleBarThemeTests
{
    [Theory]
    [InlineData("default", "default")]
    [InlineData("blue", "blue")]
    [InlineData("Blue", "default")]
    [InlineData("ocean", "default")]
    [InlineData("", "default")]
    [InlineData(null, "default")]
    public void NormalizePalette_falls_back_to_default(string? palette, string expected)
    {
        Assert.Equal(expected, TitleBarTheme.NormalizePalette(palette));
    }

    [Fact]
    public void NormalizePalette_keeps_blue()
    {
        Assert.Equal("blue", TitleBarTheme.NormalizePalette("blue"));
        Assert.Equal("default", TitleBarTheme.DefaultPalette);
    }

    [Fact]
    public void Resolve_blue_light_matches_frontend_chrome()
    {
        var colors = TitleBarTheme.Resolve("blue", lightTheme: true);

        Assert.Equal("#E6EFFF", colors.Background);
        Assert.Equal("#C9D9F7", colors.Border);
        Assert.Equal("#D9E6FF", colors.Hover);
        Assert.Equal("#D4E3FF", colors.Active);
        Assert.Equal("#F3F8FF", colors.Content);
        Assert.Equal("#1F2328", colors.Foreground);
    }

    [Fact]
    public void Resolve_blue_dark_matches_frontend_chrome()
    {
        var colors = TitleBarTheme.Resolve("blue", lightTheme: false);

        Assert.Equal("#101A2E", colors.Background);
        Assert.Equal("#22304A", colors.Border);
        Assert.Equal("#18243C", colors.Hover);
        Assert.Equal("#1B2A4A", colors.Active);
        Assert.Equal("#0C1424", colors.Content);
        Assert.Equal("#E6EDF3", colors.Foreground);
    }

    [Fact]
    public void Resolve_default_light_matches_frontend_chrome()
    {
        var colors = TitleBarTheme.Resolve("default", lightTheme: true);

        Assert.Equal("#F3F4F6", colors.Background);
        Assert.Equal("#E2E4E8", colors.Border);
        Assert.Equal("#EAEDF1", colors.Hover);
        Assert.Equal("#E0E5EC", colors.Active);
        Assert.Equal("#FFFFFF", colors.Content);
        Assert.Equal("#1F2328", colors.Foreground);
    }

    [Fact]
    public void Resolve_default_dark_matches_frontend_chrome()
    {
        var colors = TitleBarTheme.Resolve("default", lightTheme: false);

        Assert.Equal("#16181D", colors.Background);
        Assert.Equal("#2A2D34", colors.Border);
        Assert.Equal("#1F222A", colors.Hover);
        Assert.Equal("#282C35", colors.Active);
        Assert.Equal("#0D0F13", colors.Content);
        Assert.Equal("#E6EDF3", colors.Foreground);
    }

    [Fact]
    public void Resolve_unknown_palette_falls_back_to_default()
    {
        Assert.Equal(
            TitleBarTheme.Resolve("default", lightTheme: true),
            TitleBarTheme.Resolve("ocean", lightTheme: true));
        Assert.Equal(
            TitleBarTheme.Resolve("default", lightTheme: false),
            TitleBarTheme.Resolve(null, lightTheme: false));
    }

    [Theory]
    [InlineData(1, true)]
    [InlineData(0, false)]
    [InlineData(2, true)]
    [InlineData(-1, true)]
    [InlineData("1", true)]
    [InlineData("0", false)]
    [InlineData("oops", true)]
    [InlineData(null, true)]
    public void IsLightAppsTheme_reads_registry_value(object? value, bool expected)
    {
        Assert.Equal(expected, TitleBarTheme.IsLightAppsTheme(value));
    }

    [Theory]
    [InlineData("a.md", "a.md — 鲸鲸阅读器")]
    [InlineData("笔记.md", "笔记.md — 鲸鲸阅读器")]
    [InlineData("", "鲸鲸阅读器")]
    [InlineData("   ", "鲸鲸阅读器")]
    [InlineData(null, "鲸鲸阅读器")]
    public void FormatTitle_uses_file_name_or_product_name(string? fileName, string expected)
    {
        Assert.Equal(expected, TitleBarTheme.FormatTitle(fileName));
    }

    [Theory]
    [InlineData("light", 0, true)] // 固定浅色优先于系统深色
    [InlineData("dark", 1, false)] // 固定深色优先于系统浅色
    [InlineData("system", 1, true)]
    [InlineData("system", 0, false)]
    [InlineData("bogus", 0, false)] // 非法主题按 system 处理
    [InlineData(null, null, true)]
    public void ResolveLightTheme_follows_app_theme_then_system(string? theme, object? appsUseLightTheme, bool expected)
    {
        Assert.Equal(expected, TitleBarTheme.ResolveLightTheme(theme, appsUseLightTheme));
    }

    [Fact]
    public void MaximizeButton_switches_glyph_and_tooltip()
    {
        Assert.Equal("\uE922", TitleBarTheme.MaximizeButtonGlyph(maximized: false));
        Assert.Equal("\uE923", TitleBarTheme.MaximizeButtonGlyph(maximized: true));
        Assert.Equal("最大化", TitleBarTheme.MaximizeButtonTooltip(maximized: false));
        Assert.Equal("还原", TitleBarTheme.MaximizeButtonTooltip(maximized: true));
        Assert.Equal(32d, TitleBarTheme.CaptionHeight);
    }

    [Fact]
    public void BackdropTopHeight_covers_frontend_toolbar_and_top_margin()
    {
        // 顶部 chrome 横条必须盖住前端 --toolbar-height（40 DIP），否则 WebView 右上的 6 DIP 边距
        // 会在顶栏高度内露出正文色；标题栏（32 DIP）独占根网格第一行，不属于内容行。
        Assert.Equal(40d, TitleBarTheme.ToolbarHeight);
        Assert.Equal(0d, TitleBarTheme.ContentTopMargin);
        Assert.Equal(40d, TitleBarTheme.BackdropTopHeight());
        Assert.Equal(32d, TitleBarTheme.CaptionHeight);
    }

    [Theory]
    [InlineData(true, 240, 246d)] // 目录可见：TocWidth（含 1px 分隔线）+ 6 DIP 边距
    [InlineData(true, 180, 186d)]
    [InlineData(true, 0, 6d)]
    [InlineData(false, 240, 0d)] // 折叠：左列归 0，底板整条正文色
    [InlineData(false, 0, 0d)]
    public void BackdropTocWidth_matches_toc_and_margin(bool tocVisible, int tocWidth, double expected)
    {
        Assert.Equal(expected, TitleBarTheme.BackdropTocWidth(tocVisible, tocWidth));
        Assert.Equal(6d, TitleBarTheme.ContentMargin);
    }
}
