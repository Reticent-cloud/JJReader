using System.IO;
using Microsoft.Web.WebView2.Core;

namespace JingjingReader;

/// <summary>PDF 打印参数（默认 A4 8.27 × 11.69 英寸、四边 12 mm ≈ 0.472 英寸、打印背景开启）。</summary>
public sealed record PdfOptions(
    double PageWidthIn = 8.27,
    double PageHeightIn = 11.69,
    double MarginIn = 0.472,
    bool PrintBackgrounds = true);

/// <summary>
/// PDF 导出（Task 15）：先让前端进入打印模式（隐藏工具条/侧栏、强制浅色），等前端发
/// <c>readyToPrint</c> 后按 A4/12mm 调 <c>PrintToPdfAsync</c> 落盘，最后无论成功/失败/超时都恢复界面。
/// 只依赖 <see cref="CoreWebView2"/>（打印设置必须由 WebView2 环境创建），不接触 WPF，便于保持极薄宿主。
/// </summary>
public static class PdfExport
{
    /// <summary>
    /// 等待前端 readyToPrint 的上限：前端进入打印模式前要先同步 <c>renderAll</c> 大文档尚未渲染的块
    /// （&gt;512 KB 走分块懒渲染），因此从 5 s 放宽到 10 s；<c>--verify-pdf</c> 的外层 60 s 保护不变。
    /// </summary>
    public const int ReadyTimeoutMilliseconds = 10_000;

    private const string EnterPrintModeScript = "window.JJ.enterPrintModeForPdf()";
    private const string ExitPrintModeScript = "window.JJ.exitPrintModeForPdf()";

    private static readonly object Gate = new();

    /// <summary>进行中的导出：readyToPrint 由 MainWindow 的消息分派调用 <see cref="NotifyReadyToPrint"/> 完成。</summary>
    private static TaskCompletionSource<bool>? _readyToPrint;

    /// <summary>同一时间只允许一个导出（WebView2 也限制同时只有一个打印任务）。</summary>
    private static bool _exporting;

    /// <summary>默认打印参数（A4，12mm 边距，打印背景）。</summary>
    public static PdfOptions Default { get; } = new();

    /// <summary>
    /// 把 <see cref="PdfOptions"/> 换算成打印设置需要的英寸值；四边使用同一个 MarginIn（brief：边距四边相同）。
    /// 纯函数，便于单测（CoreWebView2PrintSettings 无法在单测里构造）。
    /// </summary>
    public static (
        double PageWidthIn,
        double PageHeightIn,
        double MarginTopIn,
        double MarginBottomIn,
        double MarginLeftIn,
        double MarginRightIn,
        bool PrintBackgrounds) ToPrintValues(PdfOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return (
            options.PageWidthIn,
            options.PageHeightIn,
            options.MarginIn,
            options.MarginIn,
            options.MarginIn,
            options.MarginIn,
            options.PrintBackgrounds);
    }

    /// <summary>
    /// 前端在进入打印模式后发 <c>readyToPrint</c>：唤醒正在等待的导出。
    /// 没有导出时（迟到消息/误发）只记日志，绝不抛异常。
    /// </summary>
    public static void NotifyReadyToPrint()
    {
        TaskCompletionSource<bool>? ready;
        lock (Gate)
        {
            ready = _readyToPrint;
        }

        if (ready is null)
        {
            DebugLog.Write("忽略 readyToPrint：当前没有进行中的 PDF 导出");
            return;
        }

        ready.TrySetResult(true);
    }

    /// <summary>
    /// 导出当前页面为 PDF：进入打印模式 → 等 readyToPrint（10 s，含大文档同步 renderAll）→ PrintToPdfAsync → 恢复界面。
    /// 任何失败/超时都返回 false（并记录日志），界面恢复放在 finally 里保证执行。
    /// </summary>
    /// <param name="webView">已初始化完成的 WebView2 核心对象。</param>
    /// <param name="outputPath">PDF 输出路径（允许相对路径，内部转绝对路径）。</param>
    /// <returns>成功写出 PDF 返回 true，否则 false。</returns>
    public static async Task<bool> ExportAsync(CoreWebView2 webView, string outputPath)
    {
        ArgumentNullException.ThrowIfNull(webView);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);

        TaskCompletionSource<bool> ready;

        lock (Gate)
        {
            if (_exporting)
            {
                DebugLog.Write("PDF 导出已在进行中，忽略重复请求");
                return false;
            }

            _exporting = true;
            ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _readyToPrint = ready;
        }

        var fullPath = Path.GetFullPath(outputPath);
        try
        {
            try
            {
                await webView.ExecuteScriptAsync(EnterPrintModeScript);
            }
            catch (Exception exception)
            {
                // WebView2 已关闭/脚本执行环境不可用：导出失败，但仍走 finally 清理导出状态。
                DebugLog.Write($"进入打印模式失败：{exception.Message}");
                return false;
            }

            var timeout = Task.Delay(ReadyTimeoutMilliseconds);
            var finished = await Task.WhenAny(ready.Task, timeout);
            if (finished != ready.Task)
            {
                DebugLog.Write($"等待 readyToPrint 超时（{ReadyTimeoutMilliseconds} ms）");
                return false;
            }

            var settings = TryCreatePrintSettings(webView, Default);
            var printed = await webView.PrintToPdfAsync(fullPath, settings);
            if (!printed)
            {
                DebugLog.Write($"PrintToPdfAsync 返回 false path={fullPath}");
            }

            return printed;
        }
        catch (Exception exception)
        {
            // UI 边界：路径非法/打印任务冲突/WebView2 关闭都可能抛异常，统一转成失败返回值。
            DebugLog.Write($"PDF 导出失败 path={fullPath}：{exception}");
            return false;
        }
        finally
        {
            try
            {
                await webView.ExecuteScriptAsync(ExitPrintModeScript);
            }
            catch (Exception exception)
            {
                DebugLog.Write($"退出打印模式失败：{exception.Message}");
            }

            lock (Gate)
            {
                _exporting = false;
                _readyToPrint = null;
            }
        }
    }

    /// <summary>
    /// 创建并按 A4/12mm/打印背景配置打印设置；环境不可用/创建失败时返回 null（WebView2 使用默认设置）。
    /// CoreWebView2PrintSettings 只能由 CoreWebView2Environment.CreatePrintSettings() 创建。
    /// </summary>
    private static CoreWebView2PrintSettings? TryCreatePrintSettings(CoreWebView2 webView, PdfOptions options)
    {
        CoreWebView2PrintSettings? settings;
        try
        {
            settings = webView.Environment?.CreatePrintSettings();
        }
        catch (Exception exception)
        {
            DebugLog.Write($"创建打印设置失败，退回 WebView2 默认值：{exception.Message}");
            return null;
        }

        if (settings is null)
        {
            DebugLog.Write("WebView2 环境不可用，使用默认打印设置");
            return null;
        }

        var values = ToPrintValues(options);
        settings.PageWidth = values.PageWidthIn;
        settings.PageHeight = values.PageHeightIn;
        settings.MarginTop = values.MarginTopIn;
        settings.MarginBottom = values.MarginBottomIn;
        settings.MarginLeft = values.MarginLeftIn;
        settings.MarginRight = values.MarginRightIn;
        settings.ShouldPrintBackgrounds = values.PrintBackgrounds;
        return settings;
    }
}
