using System.IO;

namespace JingjingReader;

/// <summary>
/// 应用数据路径的唯一计算处（Task 16）：保证 MainWindow、--install/--uninstall 与关于面板
/// 使用的是同一个 <c>%APPDATA%\JingjingReader</c>，避免多处手拼路径出现分叉。
/// 验收隔离（修复波 B-I2）：设置环境变量 <c>JJ_DATA_DIR</c>（仅用于测试隔离）时，数据目录与
/// WebView2 用户数据目录都改到该目录下；生产默认路径不变——数据目录在漫游 <c>%APPDATA%</c>，
/// WebView2 用户数据目录在本地 <c>%LOCALAPPDATA%</c>（修复波 D：漫游/域重定向路径可能是 UNC，
/// WebView2 官方明确不建议作为 UDF）。
/// </summary>
public static class AppPaths
{
    /// <summary>数据目录名（%APPDATA% 与 %LOCALAPPDATA% 下共用）。</summary>
    public const string DataDirectoryName = "JingjingReader";

    /// <summary>备份文件名（安装前的 .md 关联状态，卸载时据此恢复）。</summary>
    public const string AssocBackupFileName = "assoc-backup.json";

    /// <summary>调试日志文件名。</summary>
    public const string DebugLogFileName = "debug.log";

    /// <summary>验收隔离用的数据目录环境变量：设置后 settings/recent/positions/debug.log 与 WebView2 profile 都落在该目录（仅测试隔离，不是生产配置项）。</summary>
    public const string DataDirOverrideVariable = "JJ_DATA_DIR";

    /// <summary>WebView2 用户数据目录名（数据目录下 / 本地应用数据下）。</summary>
    public const string WebViewDataDirectoryName = "WebView2";

    /// <summary>
    /// 数据目录 <c>%APPDATA%\JingjingReader</c>（或 <c>JJ_DATA_DIR</c> 覆盖值）；只计算路径，不创建目录
    /// （getter 不产生副作用，目录不可写时也不会在取路径的地方抛异常）。需要落盘的调用方自行创建并处理失败：
    /// Store/DebugLog/关联备份写入都会在真正写入前 <c>Directory.CreateDirectory</c>。
    /// </summary>
    public static string DataDir
    {
        get
        {
            var overridden = Environment.GetEnvironmentVariable(DataDirOverrideVariable);
            return ResolveDataDir(
                overridden,
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
        }
    }

    /// <summary>
    /// 数据目录解析（纯函数，便于单测）：覆盖值为空/空白/非法路径时回退默认 <c>&lt;appData&gt;\JingjingReader</c>。
    /// 覆盖值按当前目录展开为绝对路径，与 NormalizePath 的「相对→绝对」口径一致。
    /// </summary>
    internal static string ResolveDataDir(string? overrideValue, string appDataRoot)
    {
        return TryResolveOverride(overrideValue, out var overridden)
            ? overridden
            : Path.Combine(appDataRoot, DataDirectoryName);
    }

    /// <summary>
    /// WebView2 用户数据目录（UDF）：
    /// 未设置 <c>JJ_DATA_DIR</c> 时固定为本地 <c>%LOCALAPPDATA%\JingjingReader\WebView2</c>；
    /// 设置时为其下的 <c>WebView2</c>（验收隔离）。UDF 不放漫游 <c>%APPDATA%</c>：
    /// 域环境/文件夹重定向下它可能是 UNC 网络盘，WebView2 官方明确不建议（慢/崩溃/丢数据）。
    /// </summary>
    public static string WebViewDataDir
    {
        get
        {
            var overridden = Environment.GetEnvironmentVariable(DataDirOverrideVariable);
            return ResolveWebViewDataDir(
                overridden,
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        }
    }

    /// <summary>
    /// WebView2 UDF 解析（纯函数，便于单测）：覆盖值有效时用 <c>&lt;override&gt;\WebView2</c>，
    /// 否则回退本地默认 <c>&lt;localAppData&gt;\JingjingReader\WebView2</c>（非法覆盖值不能把 UDF 带回漫游目录）。
    /// </summary>
    internal static string ResolveWebViewDataDir(string? overrideValue, string localAppDataRoot)
    {
        return TryResolveOverride(overrideValue, out var overridden)
            ? Path.Combine(overridden, WebViewDataDirectoryName)
            : Path.Combine(localAppDataRoot, DataDirectoryName, WebViewDataDirectoryName);
    }

    /// <summary><c>%APPDATA%\JingjingReader\assoc-backup.json</c>。</summary>
    public static string AssocBackupPath => Path.Combine(DataDir, AssocBackupFileName);

    /// <summary><c>%APPDATA%\JingjingReader\debug.log</c>（spec §7）。</summary>
    public static string DebugLogPath => Path.Combine(DataDir, DebugLogFileName);

    /// <summary>
    /// 覆盖值解析：空/空白/非法路径返回 false（调用方回退默认）。非法值不能抛异常把程序变成不可用。
    /// </summary>
    private static bool TryResolveOverride(string? overrideValue, out string resolved)
    {
        resolved = string.Empty;
        if (string.IsNullOrWhiteSpace(overrideValue))
        {
            return false;
        }

        try
        {
            resolved = Path.GetFullPath(overrideValue.Trim());
            return true;
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException or FormatException)
        {
            return false;
        }
    }
}
