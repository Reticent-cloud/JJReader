using System.Windows;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// I1 窗口几何夹紧（spec §5.1）：启动时把 settings.Window 夹紧到虚拟屏幕工作区。
/// 覆盖完全在屏、部分出屏、全部出屏、超小屏、负坐标（左侧/上方副屏）与非法值。
/// </summary>
public class WindowGeometryClampTests
{
    private static readonly Rect PrimaryWorkArea = new(0, 0, 1920, 1040);

    [Fact]
    public void Keeps_geometry_fully_inside_work_area()
    {
        var geometry = new WindowGeometry(100, 80, 1000, 760);

        var clamped = WindowGeometryClamp.Clamp(geometry, PrimaryWorkArea);

        Assert.Equal(geometry, clamped);
    }

    [Fact]
    public void Moves_partially_offscreen_window_back_inside()
    {
        // 右下角超出：右边 2800 > 1920、下边 1760 > 1040
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(1800, 1000, 1000, 760), PrimaryWorkArea);

        Assert.Equal(920, clamped.X);
        Assert.Equal(280, clamped.Y);
        Assert.Equal(1000, clamped.W);
        Assert.Equal(760, clamped.H);
    }

    [Fact]
    public void Moves_fully_offscreen_window_back_inside()
    {
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(5000, 5000, 1000, 760), PrimaryWorkArea);

        Assert.Equal(920, clamped.X);
        Assert.Equal(280, clamped.Y);
    }

    [Theory]
    [InlineData(-400, -300)]
    [InlineData(int.MinValue, int.MinValue)]
    [InlineData(int.MaxValue, int.MaxValue)]
    public void Clamps_extreme_coordinates_without_overflow(int x, int y)
    {
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(x, y, 1000, 760), PrimaryWorkArea);

        Assert.InRange(clamped.X, 0, 920);
        Assert.InRange(clamped.Y, 0, 280);
    }

    [Fact]
    public void Shrinks_to_tiny_work_area()
    {
        // 工作区比最小尺寸还小（超小屏/远程会话）：窗口退化为整块工作区
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(100, 100, 1000, 760), new Rect(0, 0, 800, 600));

        Assert.Equal(0, clamped.X);
        Assert.Equal(0, clamped.Y);
        Assert.Equal(800, clamped.W);
        Assert.Equal(600, clamped.H);
    }

    [Fact]
    public void Supports_negative_work_area_coordinates()
    {
        var secondary = new Rect(-1920, 0, 1920, 1040);

        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(-2500, -100, 1000, 760), secondary);
        Assert.Equal(-1920, clamped.X);
        Assert.Equal(0, clamped.Y);
        Assert.Equal(1000, clamped.W);

        var inside = WindowGeometryClamp.Clamp(new WindowGeometry(-1500, 100, 1000, 760), secondary);
        Assert.Equal(-1500, inside.X);
        Assert.Equal(100, inside.Y);
    }

    [Fact]
    public void Enforces_min_size_when_saved_size_too_small()
    {
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(10, 20, 200, 100), PrimaryWorkArea);

        Assert.Equal(WindowGeometryClamp.MinWidth, clamped.W);
        Assert.Equal(WindowGeometryClamp.MinHeight, clamped.H);
        Assert.Equal(10, clamped.X);
        Assert.Equal(20, clamped.Y);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Uses_default_size_for_invalid_saved_size(int invalid)
    {
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(10, 20, invalid, invalid), PrimaryWorkArea);

        Assert.Equal(WindowGeometryClamp.DefaultWidth, clamped.W);
        Assert.Equal(WindowGeometryClamp.DefaultHeight, clamped.H);
    }

    [Fact]
    public void Preserves_maximized_flag()
    {
        var clamped = WindowGeometryClamp.Clamp(new WindowGeometry(-999, -999, 1000, 760, Max: true), PrimaryWorkArea);

        Assert.True(clamped.Max);
        Assert.Equal(0, clamped.X);
        Assert.Equal(0, clamped.Y);
    }
}
