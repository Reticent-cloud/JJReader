using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Windows;

namespace JingjingReader;

/// <summary>
/// <c>--verify-pdf &lt;in.md&gt; &lt;out.pdf&gt;</c> 集成自检（Task 15）：离屏窗口打开文档，等前端
/// <c>renderDone</c> 后调用 <see cref="PdfExport.ExportAsync"/>；成功且 PDF &gt; 5 KB 时向 stdout 打一行
/// <c>PDF-READY {json}</c> 并以 0 退出，等待超时/导出失败以 2 退出。
/// </summary>
public static class VerifyPdf
{
    /// <summary>等待 renderDone 的上限（与 --verify-render 同口径：15 s）。</summary>
    public const int DefaultTimeoutMilliseconds = 15_000;

    /// <summary>PrintToPdf 的总上限：正常单页文档 < 1 s，留足大文档/慢磁盘余量。</summary>
    public const int ExportTimeoutMilliseconds = 60_000;

    /// <summary>PDF 最小体积门禁（brief：&gt; 5 KB）。</summary>
    public const long MinimumPdfBytes = 5 * 1024;

    /// <summary>PDF-READY 行给人看：中文路径不转义成 \uXXXX（仍是合法 JSON，脚本可正常解析）。</summary>
    private static readonly JsonSerializerOptions ReadyJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>执行自检并结束应用（调用方是 App.OnStartup，消息循环已就绪）。</summary>
    public static async Task Run(string inputPath, string outputPath, int timeoutMs = DefaultTimeoutMilliseconds)
    {
        try
        {
            await RunCoreAsync(inputPath, outputPath, timeoutMs);
        }
        catch (Exception exception)
        {
            // 自检是命令行入口：任何异常都要转成「失败 + 退出码 2」，不能挂在未处理异常上。
            DebugLog.Write($"verify-pdf 异常：{exception}");
            ConsoleHelper.WriteLine($"PDF-FAILED 内部错误：{exception.Message}");
            Application.Current?.Shutdown(2);
        }
    }

    private static async Task RunCoreAsync(string inputPath, string outputPath, int timeoutMs)
    {
        var normalizedInput = FileHost.NormalizePath(inputPath);
        var fullOutput = Path.GetFullPath(outputPath);
        var completion = new TaskCompletionSource<InboundMessage>(TaskCreationOptions.RunContinuationsAsynchronously);

        var window = new MainWindow();
        if (Application.Current is { } application)
        {
            application.MainWindow = window;
        }

        // 不打扰用户：任务栏无图标、不抢焦点、窗口放到屏幕外；仍必须 Show() 才能完成渲染。
        window.ShowInTaskbar = false;
        window.ShowActivated = false;
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = -32000;
        window.Top = -32000;
        window.RenderDone += message => completion.TrySetResult(message);
        window.Show();

        window.OpenDocument(normalizedInput);

        var finished = await Task.WhenAny(completion.Task, Task.Delay(timeoutMs));
        if (finished != completion.Task)
        {
            DebugLog.Write($"verify-pdf 等待 renderDone 超时 input={normalizedInput} timeoutMs={timeoutMs}");
            ConsoleHelper.WriteLine($"PDF-FAILED 等待 renderDone 超时（{timeoutMs} ms）：{normalizedInput}");
            Application.Current?.Shutdown(2);
            return;
        }

        var core = window.WebView.CoreWebView2;
        if (core is null)
        {
            DebugLog.Write("verify-pdf WebView2 未就绪");
            ConsoleHelper.WriteLine("PDF-FAILED WebView2 未就绪");
            Application.Current?.Shutdown(2);
            return;
        }

        var started = DateTimeOffset.Now;
        var exportTask = PdfExport.ExportAsync(core, fullOutput);
        var exported = await Task.WhenAny(exportTask, Task.Delay(ExportTimeoutMilliseconds));
        if (exported != exportTask)
        {
            DebugLog.Write($"verify-pdf 导出超时 output={fullOutput} timeoutMs={ExportTimeoutMilliseconds}");
            ConsoleHelper.WriteLine($"PDF-FAILED 导出超时（{ExportTimeoutMilliseconds} ms）：{fullOutput}");
            Application.Current?.Shutdown(2);
            return;
        }

        if (!await exportTask)
        {
            DebugLog.Write($"verify-pdf 导出失败 output={fullOutput}");
            ConsoleHelper.WriteLine($"PDF-FAILED 导出失败：{fullOutput}");
            Application.Current?.Shutdown(2);
            return;
        }

        var file = new FileInfo(fullOutput);
        if (!file.Exists || file.Length <= MinimumPdfBytes)
        {
            var size = file.Exists ? file.Length : 0;
            DebugLog.Write($"verify-pdf PDF 缺失或过小 output={fullOutput} bytes={size}");
            ConsoleHelper.WriteLine($"PDF-FAILED PDF 文件缺失或过小：{fullOutput} bytes={size}");
            Application.Current?.Shutdown(2);
            return;
        }

        var result = new
        {
            ready = true,
            input = normalizedInput,
            output = fullOutput,
            bytes = file.Length,
            elapsedMs = (long)Math.Round((DateTimeOffset.Now - started).TotalMilliseconds),
        };

        DebugLog.Write($"verify-pdf PDF-READY output={fullOutput} bytes={file.Length}");
        ConsoleHelper.WriteLine("PDF-READY " + JsonSerializer.Serialize(result, ReadyJsonOptions));
        Application.Current?.Shutdown(0);
    }
}
