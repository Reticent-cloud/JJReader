using System.Windows;

namespace JingjingReader;

/// <summary>
/// 窗口几何夹紧（spec §5.1「记住窗口位置、大小、最大化状态」）：启动时把 settings.json 里的
/// <see cref="WindowGeometry"/> 夹紧到目标屏幕的工作区，避免显示器拔插/分辨率变化后窗口落在屏幕外
/// （标题栏拖不到、用户以为程序没启动）。纯函数、不碰 WPF 窗口，便于单测。
/// </summary>
public static class WindowGeometryClamp
{
    /// <summary>与 MainWindow.xaml 的 MinWidth 一致（spec §5.1：最小 640×480）。</summary>
    public const int MinWidth = 640;

    /// <summary>与 MainWindow.xaml 的 MinHeight 一致。</summary>
    public const int MinHeight = 480;

    /// <summary>默认窗口尺寸（spec §5.1：默认 1000×760）。</summary>
    public const int DefaultWidth = 1000;

    /// <summary>默认窗口尺寸（spec §5.1：默认 1000×760）。</summary>
    public const int DefaultHeight = 760;

    /// <summary>
    /// 把窗口几何夹紧到 <paramref name="workArea"/>（屏幕工作区，可能为负坐标的多显示器环境）：
    /// <list type="bullet">
    /// <item>宽高先夹到 [最小值, 工作区尺寸]；工作区比最小尺寸还小时退化为整块工作区（超小屏）。</item>
    /// <item>左上角夹到能完整放下窗口的范围；窗口比工作区大时贴住工作区左上角。</item>
    /// <item>非法宽高（≤0）用默认 1000×760 参与计算；坐标用 long 运算避免极端值溢出。</item>
    /// <item><c>Max</c>（最大化状态）原样保留，不影响夹紧结果。</item>
    /// </list>
    /// </summary>
    public static WindowGeometry Clamp(WindowGeometry geometry, Rect workArea)
    {
        ArgumentNullException.ThrowIfNull(geometry);

        var areaLeft = ToLong(workArea.Left);
        var areaTop = ToLong(workArea.Top);
        var areaWidth = Math.Max(0L, ToLong(workArea.Width));
        var areaHeight = Math.Max(0L, ToLong(workArea.Height));

        // 宽高：非法值退回默认；夹到 [最小尺寸, 工作区]；工作区更小时取工作区（超小屏优先保证完整可见）。
        var requestedWidth = geometry.W > 0 ? geometry.W : DefaultWidth;
        var requestedHeight = geometry.H > 0 ? geometry.H : DefaultHeight;
        var minWidth = Math.Min((long)MinWidth, areaWidth);
        var minHeight = Math.Min((long)MinHeight, areaHeight);
        // 工作区尺寸非法（0/负）时不做上限约束，至少保留一个可用的默认尺寸。
        var width = areaWidth <= 0
            ? Math.Max((long)requestedWidth, MinWidth)
            : Math.Clamp((long)requestedWidth, minWidth, Math.Max(minWidth, areaWidth));
        var height = areaHeight <= 0
            ? Math.Max((long)requestedHeight, MinHeight)
            : Math.Clamp((long)requestedHeight, minHeight, Math.Max(minHeight, areaHeight));

        // 位置：夹到 [工作区起点, 工作区终点 - 窗口尺寸]；窗口比工作区大时自然落在起点。
        var maxLeft = Math.Max(areaLeft, areaLeft + areaWidth - width);
        var maxTop = Math.Max(areaTop, areaTop + areaHeight - height);
        var left = Math.Clamp((long)geometry.X, areaLeft, maxLeft);
        var top = Math.Clamp((long)geometry.Y, areaTop, maxTop);

        return geometry with
        {
            X = (int)left,
            Y = (int)top,
            W = (int)width,
            H = (int)height,
        };
    }

    private static long ToLong(double value)
        => double.IsNaN(value) || double.IsInfinity(value) ? 0L : (long)Math.Round(value);
}
