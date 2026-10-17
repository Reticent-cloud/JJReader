using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Windows;

namespace JingjingReader;

/// <summary>
/// <c>--verify-render &lt;file&gt;</c> 自检：离屏创建窗口并打开文档，等待前端 <c>renderDone</c>，
/// 成功时向 stdout 打一行 READY JSON 并以 0 退出；15 s 超时以 2 退出并在控制台说明。
/// </summary>
public static class VerifyRender
{
    /// <summary>等待 renderDone 的上限（brief：15 s）。</summary>
    public const int DefaultTimeoutMilliseconds = 15_000;

    /// <summary>READY 行给人看：中文路径不转义成 \uXXXX（仍是合法 JSON，脚本可正常解析）。</summary>
    private static readonly JsonSerializerOptions ReadyJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>执行自检并结束应用（调用方是 App.OnStartup，消息循环已就绪）。</summary>
    public static async Task Run(string path, int timeoutMs = DefaultTimeoutMilliseconds)
    {
        try
        {
            await RunCoreAsync(path, timeoutMs);
        }
        catch (Exception exception)
        {
            // 自检是命令行入口：任何异常都要转成「失败 + 退出码 2」，不能挂在未处理异常上。
            DebugLog.Write($"verify-render 异常：{exception}");
            ConsoleHelper.WriteLine($"VERIFY-FAILED 内部错误：{exception.Message}");
            Application.Current?.Shutdown(2);
        }
    }

    private static async Task RunCoreAsync(string path, int timeoutMs)
    {
        var normalizedPath = FileHost.NormalizePath(path);

        // 输入不存在时快速失败（exit 2）：不必等 15 s renderDone 超时，验收脚本也能立刻看到原因。
        if (!File.Exists(normalizedPath))
        {
            DebugLog.Write($"verify-render 输入文件不存在 path={normalizedPath}");
            ConsoleHelper.WriteLine($"VERIFY-FAILED 输入文件不存在：{normalizedPath}");
            Application.Current?.Shutdown(2);
            return;
        }

        var completion = new TaskCompletionSource<InboundMessage>(TaskCreationOptions.RunContinuationsAsynchronously);

        var window = new MainWindow();
        if (Application.Current is { } application)
        {
            application.MainWindow = window;
        }

        // 不打扰用户：任务栏无图标、不抢焦点、窗口放到屏幕外。
        // 仍必须 Show()：完全隐藏（Visibility=Hidden）时 WebView2 不会完成初始化/渲染，renderDone 永远不会到。
        window.ShowInTaskbar = false;
        window.ShowActivated = false;
        // I1：离屏自检窗口的几何不能写回用户 settings.json（-32000 会覆盖真实窗口位置）。
        window.SuppressGeometryPersistence = true;
        // I3：命令行自检不弹需要人点的模态框（缺运行时快速失败）。
        window.SuppressFailureDialog = true;
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = -32000;
        window.Top = -32000;
        window.RenderDone += message => completion.TrySetResult(message);
        window.Show();

        window.OpenDocument(normalizedPath);

        var finished = await Task.WhenAny(completion.Task, Task.Delay(timeoutMs));
        if (finished != completion.Task)
        {
            DebugLog.Write($"verify-render 超时 path={normalizedPath} timeoutMs={timeoutMs}");
            ConsoleHelper.WriteLine($"VERIFY-FAILED 等待 renderDone 超时（{timeoutMs} ms）：{normalizedPath}");
            Application.Current?.Shutdown(2);
            return;
        }

        var renderDone = await completion.Task;
        var result = new
        {
            ready = true,
            path = string.IsNullOrWhiteSpace(renderDone.Path) ? normalizedPath : renderDone.Path,
            elapsedMs = (long)Math.Round(renderDone.ElapsedMs),
            tocCount = renderDone.TocCount,
        };

        DebugLog.Write($"verify-render READY path={result.path} elapsedMs={result.elapsedMs} tocCount={result.tocCount}");
        ConsoleHelper.WriteLine("READY " + JsonSerializer.Serialize(result, ReadyJsonOptions));
        Application.Current?.Shutdown(0);
    }
}
