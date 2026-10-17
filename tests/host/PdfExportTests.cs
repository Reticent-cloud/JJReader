using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// PdfExport（Task 15）：A4/12mm 默认值、英寸换算的纯函数，以及 readyToPrint 通知在无导出时的安全性。
/// CoreWebView2 只能由 WebView2 运行时创建，单测不构造它——导出主流程由 <c>--verify-pdf</c> 集成实测覆盖。
/// </summary>
public class PdfExportTests
{
    [Fact]
    public void Default_is_a4_with_12mm_margin()
    {
        Assert.Equal(8.27, PdfExport.Default.PageWidthIn, 2);
        Assert.Equal(11.69, PdfExport.Default.PageHeightIn, 2);
        Assert.Equal(0.472, PdfExport.Default.MarginIn, 3);
        Assert.True(PdfExport.Default.PrintBackgrounds);
    }

    [Fact]
    public void ToPrintValues_uses_the_same_margin_on_all_four_sides()
    {
        var values = PdfExport.ToPrintValues(new PdfOptions(8.27, 11.69, 0.472, true));

        Assert.Equal(0.472, values.MarginTopIn);
        Assert.Equal(0.472, values.MarginBottomIn);
        Assert.Equal(0.472, values.MarginLeftIn);
        Assert.Equal(0.472, values.MarginRightIn);
    }

    [Fact]
    public void ToPrintValues_maps_page_size_and_backgrounds()
    {
        var values = PdfExport.ToPrintValues(new PdfOptions(10, 20, 1.5, false));

        Assert.Equal(10, values.PageWidthIn);
        Assert.Equal(20, values.PageHeightIn);
        Assert.False(values.PrintBackgrounds);
    }

    [Fact]
    public void ToPrintValues_passes_print_backgrounds_through()
    {
        Assert.True(PdfExport.ToPrintValues(new PdfOptions(PrintBackgrounds: true)).PrintBackgrounds);
        Assert.False(PdfExport.ToPrintValues(new PdfOptions(PrintBackgrounds: false)).PrintBackgrounds);
    }

    [Fact]
    public void NotifyReadyToPrint_without_an_export_is_safe()
    {
        // 没有进行中的导出时收到 readyToPrint（迟到消息/前端误发）不能抛，也不能影响下一次导出。
        PdfExport.NotifyReadyToPrint();
        PdfExport.NotifyReadyToPrint();
    }

    [Fact]
    public void ReadyTimeout_covers_synchronous_render_all_for_large_documents()
    {
        // >512 KB 的分块文档进入打印模式前要先同步 renderAll 全文，5 s 不够；放宽到 10 s（--verify-pdf 外层 60 s 不变）。
        Assert.Equal(10_000, PdfExport.ReadyTimeoutMilliseconds);
        Assert.True(PdfExport.ReadyTimeoutMilliseconds > 5_000);
    }
}
