using System.IO;
using System.Runtime.CompilerServices;
using Microsoft.Web.WebView2.Core;

// 单测不构造 CoreWebView2：经 internal 的 IPrintHost 接缝与短超时重载覆盖路径校验、超时和状态复位。
[assembly: InternalsVisibleTo("JingjingReader.Tests")]

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

    /// <summary>
    /// PrintToPdfAsync 的上限：UI 侧没有 <c>--verify-pdf</c> 那样的外层保护，打印任务卡住时
    /// 必须由 <see cref="ExportAsync(CoreWebView2, string)"/> 自己收口（返回 false 并走 finally 恢复界面）。
    /// </summary>
    public const int PrintTimeoutMilliseconds = 60_000;

    /// <summary>
    /// 退出打印模式的脚本调用上限（M8）：收尾脚本卡住时不能把导出任务永远挂在 finally 里，
    /// 超时只记日志并继续复位导出状态。
    /// </summary>
    public const int ExitScriptTimeoutMilliseconds = 3_000;

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
    /// 内部测试接缝：把导出流程对 WebView2 的两次调用抽出来，单测用假宿主覆盖完整流程。
    /// 生产实现见 <see cref="WebViewPrintHost"/>。
    /// </summary>
    internal interface IPrintHost
    {
        Task ExecuteScriptAsync(string script);

        Task<bool> PrintToPdfAsync(string fullPath);
    }

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
    /// 导出当前页面为 PDF：进入打印模式 → 等 readyToPrint（10 s，含大文档同步 renderAll）→
    /// PrintToPdfAsync（最多 60 s）→ 恢复界面。任何失败/超时/非法输出路径都返回 false（并记录日志），
    /// 界面恢复放在 finally 里保证执行；非法输出路径在置导出标志之前就被拒，不影响后续导出。
    /// </summary>
    /// <param name="webView">已初始化完成的 WebView2 核心对象。</param>
    /// <param name="outputPath">PDF 输出路径（允许相对路径，内部转绝对路径；空/非法路径返回 false）。</param>
    /// <returns>成功写出 PDF 返回 true，否则 false。</returns>
    public static Task<bool> ExportAsync(CoreWebView2 webView, string outputPath)
    {
        ArgumentNullException.ThrowIfNull(webView);
        return ExportAsync(new WebViewPrintHost(webView), outputPath);
    }

    /// <summary>
    /// 测试用重载：注入假宿主与更短的超时（默认值与生产一致）。
    /// </summary>
    internal static Task<bool> ExportAsync(
        IPrintHost host,
        string outputPath,
        int readyTimeoutMs = ReadyTimeoutMilliseconds,
        int printTimeoutMs = PrintTimeoutMilliseconds,
        int exitScriptTimeoutMs = ExitScriptTimeoutMilliseconds)
    {
        ArgumentNullException.ThrowIfNull(host);
        return ExportAsyncCore(host, outputPath, readyTimeoutMs, printTimeoutMs, exitScriptTimeoutMs);
    }

    private static async Task<bool> ExportAsyncCore(
        IPrintHost host,
        string outputPath,
        int readyTimeoutMs,
        int printTimeoutMs,
        int exitScriptTimeoutMs)
    {
        // 路径归一化必须在任何导出状态（_exporting/_readyToPrint）之前完成：
        // 非法路径（空串/NUL 等）直接返回 false，绝不能把导出状态留在进行中导致后续导出永久失败。
        if (!TryNormalizeOutputPath(outputPath, out var fullPath))
        {
            return false;
        }

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

        try
        {
            try
            {
                await host.ExecuteScriptAsync(EnterPrintModeScript);
            }
            catch (Exception exception)
            {
                // WebView2 已关闭/脚本执行环境不可用：导出失败，但仍走 finally 清理导出状态。
                DebugLog.Write($"进入打印模式失败：{exception.Message}");
                return false;
            }

            var readyTask = ready.Task;
            if (await Task.WhenAny(readyTask, Task.Delay(readyTimeoutMs)) != readyTask)
            {
                DebugLog.Write($"等待 readyToPrint 超时（{readyTimeoutMs} ms）");
                return false;
            }

            // PrintToPdfAsync 没有取消接口：卡住时只能放弃等待（并观察异常），按失败返回。
            var printTask = host.PrintToPdfAsync(fullPath);
            if (await Task.WhenAny(printTask, Task.Delay(printTimeoutMs)) != printTask)
            {
                ObserveFault(printTask);
                DebugLog.Write($"PrintToPdfAsync 超时（{printTimeoutMs} ms）path={fullPath}");
                return false;
            }

            var printed = await printTask;
            if (!printed)
            {
                DebugLog.Write($"PrintToPdfAsync 返回 false path={fullPath}");
            }

            return printed;
        }
        catch (Exception exception)
        {
            // UI 边界：打印任务冲突/WebView2 关闭都可能抛异常，统一转成失败返回值。
            DebugLog.Write($"PDF 导出失败 path={fullPath}：{exception}");
            return false;
        }
        finally
        {
            try
            {
                // M8：收尾脚本最多等 3 s；超时只记日志，导出状态照常复位。
                var exitTask = host.ExecuteScriptAsync(ExitPrintModeScript);
                if (await Task.WhenAny(exitTask, Task.Delay(exitScriptTimeoutMs)) != exitTask)
                {
                    ObserveFault(exitTask);
                    DebugLog.Write($"退出打印模式脚本超时（{exitScriptTimeoutMs} ms）");
                }
                else
                {
                    await exitTask;
                }
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
    /// 输出路径归一化：空/空白/非法字符（含 NUL）都返回 false，绝不抛异常。
    /// 放在写 <see cref="_exporting"/> 之前调用，保证异常路径不残留导出状态。
    /// </summary>
    private static bool TryNormalizeOutputPath(string? outputPath, out string fullPath)
    {
        fullPath = string.Empty;
        if (string.IsNullOrWhiteSpace(outputPath))
        {
            DebugLog.Write("PDF 导出失败：输出路径为空");
            return false;
        }

        try
        {
            fullPath = Path.GetFullPath(outputPath);
            return true;
        }
        catch (Exception exception)
        {
            // UI 边界：非法字符/NUL/超长路径等全部收口成失败返回值。
            DebugLog.Write($"PDF 导出失败：输出路径非法 path={outputPath}：{exception.Message}");
            return false;
        }
    }

    /// <summary>被超时放弃的任务若随后异常，先观察掉，避免未观察任务异常。</summary>
    private static void ObserveFault(Task task)
    {
        _ = task.ContinueWith(
            static completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    /// <summary>生产宿主：直接转调 CoreWebView2，并按 A4/12mm/打印背景创建打印设置。</summary>
    private sealed class WebViewPrintHost(CoreWebView2 webView) : IPrintHost
    {
        public Task ExecuteScriptAsync(string script) => webView.ExecuteScriptAsync(script);

        public Task<bool> PrintToPdfAsync(string fullPath)
        {
            var settings = TryCreatePrintSettings(webView, Default);
            return webView.PrintToPdfAsync(fullPath, settings);
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
