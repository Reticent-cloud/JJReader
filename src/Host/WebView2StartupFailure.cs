using Microsoft.Web.WebView2.Core;

namespace JingjingReader;

/// <summary>
/// WebView2 启动失败的原生对话框模型（spec §5.11「WebView2 运行时缺失 → 原生对话框说明 + 打开官方下载页按钮」）。
/// 纯函数：只根据异常构造文案/按钮，便于单测；实际弹窗由 <see cref="MainWindow"/> 组装。
/// 关闭对话框后的选择：显示解释页并保持窗口可用（不退出进程）——WebView2 不可用时仍让用户看到下载指引与数据目录入口；
/// 退出码 3 仅保留给命令行自检（--verify-*) 的既有语义，普通启动不因缺运行时被杀掉。
/// </summary>
public static class WebView2StartupFailure
{
    /// <summary>官方 Evergreen Runtime 下载页（spec §5.11）。</summary>
    public const string DownloadUrl = "https://developer.microsoft.com/microsoft-edge/webview2/";

    /// <summary>根据异常生成对话框文案与按钮（运行时缺失与其它初始化失败给出不同说明）。</summary>
    public static WebView2FailureDialog BuildDialogModel(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);

        var runtimeMissing = IsRuntimeMissing(exception);
        var summary = runtimeMissing
            ? "未检测到 Microsoft Edge WebView2 运行时，无法显示文档正文。请先安装 WebView2 Runtime（Evergreen），再重新启动鲸鲸阅读器。"
            : "WebView2 初始化失败，正文区域无法显示。可以尝试重新启动；若仍然失败，请安装或修复 WebView2 Runtime。";
        var detail = $"{exception.GetType().Name}: {exception.Message}";

        return new WebView2FailureDialog(
            Title: "无法启动 WebView2",
            Summary: summary,
            Detail: detail,
            DownloadUrl: DownloadUrl,
            DataDir: AppPaths.DataDir,
            DownloadButtonText: "下载 WebView2 运行时",
            OpenDataDirButtonText: "打开数据目录",
            CloseButtonText: "关闭",
            RuntimeMissing: runtimeMissing);
    }

    /// <summary>异常链里是否有 <see cref="WebView2RuntimeNotFoundException"/>（WPF 初始化常把它包在别的异常里）。</summary>
    private static bool IsRuntimeMissing(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is WebView2RuntimeNotFoundException
                || current.GetType().FullName == "Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException")
            {
                return true;
            }
        }

        return false;
    }
}

/// <summary>原生失败对话框的纯数据模型（按钮文案 + 下载地址 + 数据目录 + 异常摘要）。</summary>
public sealed record WebView2FailureDialog(
    string Title,
    string Summary,
    string Detail,
    string DownloadUrl,
    string DataDir,
    string DownloadButtonText,
    string OpenDataDirButtonText,
    string CloseButtonText,
    bool RuntimeMissing);
