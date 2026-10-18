using System.Diagnostics;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// PdfExport（Task 15）：A4/12mm 默认值、英寸换算的纯函数、readyToPrint 通知安全性，
/// 以及本次评审修复的路径校验/导出状态复位与 PrintToPdf 超时。
/// CoreWebView2 只能由 WebView2 运行时创建，单测不构造它——用 internal 的 IPrintHost 假宿主覆盖导出流程。
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
    public async Task Invalid_output_path_returns_false_without_leaving_export_state()
    {
        foreach (var invalidPath in new[] { "", "   ", "bad\0path" })
        {
            var host = new FakePrintHost();

            // 非法路径必须在置 _exporting / 碰 WebView 之前被拒：返回 false，不抛异常。
            Assert.False(await PdfExport.ExportAsync(host, invalidPath), $"非法路径应返回 false：{invalidPath}");
            Assert.Empty(host.Scripts);

            // 没有残留 _exporting=true/_readyToPrint：紧接着的正常路径仍能走完整个导出流程。
            Assert.True(await PdfExport.ExportAsync(host, "after-invalid.pdf"));
            Assert.Equal(2, host.Scripts.Count);
            Assert.Contains("enterPrintModeForPdf", host.Scripts[0]);
            Assert.Contains("exitPrintModeForPdf", host.Scripts[1]);
            Assert.EndsWith("after-invalid.pdf", host.PrintedPath);
        }
    }

    [Fact]
    public async Task Print_timeout_returns_false_and_restores_state_for_next_export()
    {
        var host = new FakePrintHost { PrintNeverCompletes = true };
        var elapsed = Stopwatch.StartNew();

        Assert.False(await PdfExport.ExportAsync(host, "timeout.pdf", readyTimeoutMs: 1_000, printTimeoutMs: 100));

        elapsed.Stop();
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(5),
            $"PrintToPdf 超时应在约 100 ms 返回，实际 {elapsed.ElapsedMilliseconds} ms");

        // 超时也必须走 finally：退出打印模式，_exporting/_readyToPrint 复位后下一次导出能正常开始。
        Assert.Equal(2, host.Scripts.Count);
        Assert.Contains("exitPrintModeForPdf", host.Scripts[1]);

        host.PrintNeverCompletes = false;
        Assert.True(await PdfExport.ExportAsync(host, "after-timeout.pdf"));
        Assert.Equal(4, host.Scripts.Count);
    }

    [Fact]
    public void Timeouts_pin_the_waiting_and_printing_budgets()
    {
        // readyToPrint 等待 10 s：前端进入打印模式前要同步 renderAll 大文档（>512 KB）未渲染块。
        Assert.Equal(10_000, PdfExport.ReadyTimeoutMilliseconds);
        // PrintToPdfAsync 自身 60 s：UI 侧没有外层保护，必须由 ExportAsync 兜住永不返回的打印任务。
        Assert.Equal(60_000, PdfExport.PrintTimeoutMilliseconds);
        Assert.True(PdfExport.PrintTimeoutMilliseconds > PdfExport.ReadyTimeoutMilliseconds);
        // M8：finally 里的退出打印模式脚本最多等 3 s。
        Assert.Equal(3_000, PdfExport.ExitScriptTimeoutMilliseconds);
    }

    [Fact]
    public async Task Exit_script_timeout_returns_without_hanging_and_resets_state()
    {
        var host = new FakePrintHost { ExitNeverCompletes = true };
        var elapsed = Stopwatch.StartNew();

        // M8：退出脚本卡住只记日志，不能把导出（以及 _exporting 状态）永远挂在 finally 里。
        Assert.True(await PdfExport.ExportAsync(host, "exit-timeout.pdf", exitScriptTimeoutMs: 100));

        elapsed.Stop();
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(3),
            $"退出脚本超时应在约 100 ms 返回，实际 {elapsed.ElapsedMilliseconds} ms");
        Assert.Equal(2, host.Scripts.Count);

        host.ExitNeverCompletes = false;
        Assert.True(await PdfExport.ExportAsync(host, "after-exit-timeout.pdf"));
        Assert.Equal(4, host.Scripts.Count);
    }

    /// <summary>
    /// 假打印宿主：执行“进入打印模式”脚本时同步回报 readyToPrint（真实流程由 MainWindow 消息分派触发），
    /// 打印按开关立即成功或永不完成，并记录调用顺序供断言。
    /// </summary>
    private sealed class FakePrintHost : PdfExport.IPrintHost
    {
        public List<string> Scripts { get; } = new();

        public bool PrintNeverCompletes { get; set; }

        /// <summary>M8：退出打印模式脚本永不完成，用于验证 finally 的超时收口。</summary>
        public bool ExitNeverCompletes { get; set; }

        public string? PrintedPath { get; private set; }

        public Task ExecuteScriptAsync(string script)
        {
            Scripts.Add(script);
            if (script.Contains("enterPrintModeForPdf", StringComparison.Ordinal))
            {
                PdfExport.NotifyReadyToPrint();
            }

            if (ExitNeverCompletes && script.Contains("exitPrintModeForPdf", StringComparison.Ordinal))
            {
                return new TaskCompletionSource().Task;
            }

            return Task.CompletedTask;
        }

        public Task<bool> PrintToPdfAsync(string fullPath)
        {
            PrintedPath = fullPath;
            return PrintNeverCompletes ? new TaskCompletionSource<bool>().Task : Task.FromResult(true);
        }
    }
}
