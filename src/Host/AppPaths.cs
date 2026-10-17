using System.IO;

namespace JingjingReader;

/// <summary>
/// 应用数据路径的唯一计算处（Task 16）：保证 MainWindow、--install/--uninstall 与关于面板
/// 使用的是同一个 <c>%APPDATA%\JingjingReader</c>，避免多处手拼路径出现分叉。
/// 验收隔离（修复波 B-I2）：设置环境变量 <c>JJ_DATA_DIR</c> 时，数据目录与 WebView2 用户数据目录
/// 都改到该目录下（仅显式设置时生效，生产默认路径不变）。
/// </summary>
public static class AppPaths
{
    /// <summary>数据目录名（%APPDATA% 与 %LOCALAPPDATA% 下共用）。</summary>
    public const string DataDirectoryName = "JingjingReader";

    /// <summary>备份文件名（安装前的 .md 关联状态，卸载时据此恢复）。</summary>
    public const string AssocBackupFileName = "assoc-backup.json";

    /// <summary>调试日志文件名。</summary>
    public const string DebugLogFileName = "debug.log";

    /// <summary>验收隔离用的数据目录环境变量：设置后 settings/recent/positions/debug.log 与 WebView2 profile 都落在该目录。</summary>
    public const string DataDirOverrideVariable = "JJ_DATA_DIR";

    /// <summary>WebView2 用户数据目录名（数据目录下）。</summary>
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
        if (!string.IsNullOrWhiteSpace(overrideValue))
        {
            try
            {
                return Path.GetFullPath(overrideValue.Trim());
            }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException or FormatException)
            {
                // 非法覆盖值回退默认：验收环境变量写错时不能把程序变成不可用
            }
        }

        return Path.Combine(appDataRoot, DataDirectoryName);
    }

    /// <summary>WebView2 用户数据目录（数据目录下的 <c>WebView2</c>；同样受 <c>JJ_DATA_DIR</c> 影响）。</summary>
    public static string WebViewDataDir => Path.Combine(DataDir, WebViewDataDirectoryName);

    /// <summary><c>%APPDATA%\JingjingReader\assoc-backup.json</c>。</summary>
    public static string AssocBackupPath => Path.Combine(DataDir, AssocBackupFileName);

    /// <summary><c>%APPDATA%\JingjingReader\debug.log</c>（spec §7）。</summary>
    public static string DebugLogPath => Path.Combine(DataDir, DebugLogFileName);
}
