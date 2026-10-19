using System.Globalization;

namespace JingjingReader;

/// <summary>
/// 自绘标题栏的配色（与前端 chrome 变量一致）：Background/Border 对应顶栏底色与分隔线，
/// Hover/Active 对应标题栏按钮状态，Content 对应正文区底色（窗口/WPF 背景），Foreground 为标题与图标文字色。
/// </summary>
public sealed record TitleBarColors(
    string Background,
    string Border,
    string Hover,
    string Active,
    string Content,
    string Foreground);

/// <summary>
/// 自绘标题栏的纯逻辑（不碰 WPF）：配色映射、系统明暗解析、标题文案与最大化按钮状态。
/// 背景：Windows 10（19045）不支持 DWM 的 <c>DWMWA_CAPTION_COLOR</c>（Win11 才有），
/// 因此主窗口改为 <c>WindowStyle=None</c> + <c>WindowChrome</c> 自绘标题栏；这里给出与
/// 前端 <c>--chrome-bg/--chrome-border/--content-bg</c> 完全一致的色值，避免标题栏与页面 chrome 断层。
/// </summary>
public static class TitleBarTheme
{
    /// <summary>默认配色（spec §5.4：首次打开为中性「默认」，浅色正文纯白；鲸鱼蓝是可选配色）。</summary>
    public const string DefaultPalette = "default";

    /// <summary>自绘标题栏高度（DIP，与 MainWindow.xaml / WindowChrome.CaptionHeight 一致）。</summary>
    public const double CaptionHeight = 32d;

    /// <summary>
    /// WebView2 四周为保留缩放热区留出的边距（DIP，与 WindowChrome.ResizeBorderThickness 一致）。
    /// 分区底板据此把左侧 chrome 区域扩展到 WebView 之外，避免底部/左侧出现颜色不符的长条。
    /// </summary>
    public const double ContentMargin = 6d;

    /// <summary>
    /// 分区底板左侧 chrome 列的宽度（DIP）：目录可见时 = 目录栏宽度（已含 1px 分隔线）+ WebView 左边距；
    /// 目录折叠时归 0（整条底板用正文色）。负宽度按 0 处理。
    /// </summary>
    public static double BackdropTocWidth(bool tocVisible, int tocWidth)
        => tocVisible ? Math.Max(0, tocWidth) + ContentMargin : 0d;

    /// <summary>非法/缺省 palette 一律回落 default（与前端 normalizePalette、宿主 SettingsPatch 白名单一致）。</summary>
    public static string NormalizePalette(string? palette)
        => palette == "blue" ? "blue" : DefaultPalette;

    /// <summary>
    /// 解析系统「应用使用浅色主题」设置（HKCU\...\Themes\Personalize\AppsUseLightTheme）：
    /// 1 = 浅色、0 = 深色；缺失/不可读/非法值按浅色（与 Windows 默认一致），保证标题栏永远有可读配色。
    /// </summary>
    public static bool IsLightAppsTheme(object? appsUseLightTheme)
    {
        if (appsUseLightTheme is null)
        {
            return true;
        }

        try
        {
            return Convert.ToInt32(appsUseLightTheme, CultureInfo.InvariantCulture) != 0;
        }
        catch (Exception exception) when (exception is FormatException or InvalidCastException or OverflowException)
        {
            return true;
        }
    }

    /// <summary>
    /// 标题栏实际明暗：前端主题设置为 light/dark 时跟随设置（保证标题栏与页面 chrome 一致），
    /// system（或非法值）时才读系统 <c>AppsUseLightTheme</c>（见 <see cref="IsLightAppsTheme"/>）。
    /// </summary>
    public static bool ResolveLightTheme(string? theme, object? appsUseLightTheme)
        => theme switch
        {
            "light" => true,
            "dark" => false,
            _ => IsLightAppsTheme(appsUseLightTheme),
        };

    /// <summary>
    /// 按 palette + 系统明暗解析标题栏色值（大写 #RRGGBB；与前端变量一一对应）：
    /// 浅色 default #F3F4F6/#E2E4E8（正文白），浅色 blue #E6EFFF/#C9D9F7（正文浅蓝白）；
    /// 深色 default #16181D/#2A2D34，深色 blue #101A2E/#22304A。
    /// </summary>
    public static TitleBarColors Resolve(string? palette, bool lightTheme)
    {
        var normalized = NormalizePalette(palette);
        if (lightTheme)
        {
            return normalized == "blue"
                ? new TitleBarColors("#E6EFFF", "#C9D9F7", "#D9E6FF", "#D4E3FF", "#F3F8FF", "#1F2328")
                : new TitleBarColors("#F3F4F6", "#E2E4E8", "#EAEDF1", "#E0E5EC", "#FFFFFF", "#1F2328");
        }

        return normalized == "blue"
            ? new TitleBarColors("#101A2E", "#22304A", "#18243C", "#1B2A4A", "#0C1424", "#E6EDF3")
            : new TitleBarColors("#16181D", "#2A2D34", "#1F222A", "#282C35", "#0D0F13", "#E6EDF3");
    }

    /// <summary>窗口标题文案：文件名 + 产品名；无文件名（空白启动页）只显示产品名。</summary>
    public static string FormatTitle(string? fileName)
        => string.IsNullOrWhiteSpace(fileName) ? "鲸鲸阅读器" : $"{fileName} — 鲸鲸阅读器";

    /// <summary>Segoe MDL2 Assets 字形：最小化（与窗口状态无关）。</summary>
    public const string MinimizeGlyph = "\uE921";

    /// <summary>Segoe MDL2 Assets 字形：最大化。</summary>
    public const string MaximizeGlyph = "\uE922";

    /// <summary>Segoe MDL2 Assets 字形：还原。</summary>
    public const string RestoreGlyph = "\uE923";

    /// <summary>Segoe MDL2 Assets 字形：关闭。</summary>
    public const string CloseGlyph = "\uE8BB";

    /// <summary>最大化按钮字形：最大化时显示「还原」，否则「最大化」。</summary>
    public static string MaximizeButtonGlyph(bool maximized) => maximized ? RestoreGlyph : MaximizeGlyph;

    /// <summary>最大化按钮 tooltip / 无障碍名称：最大化时「还原」，否则「最大化」。</summary>
    public static string MaximizeButtonTooltip(bool maximized) => maximized ? "还原" : "最大化";
}
