using System.IO;

namespace JingjingReader;

/// <summary>
/// 应用数据路径的唯一计算处（Task 16）：保证 MainWindow、--install/--uninstall 与关于面板
/// 使用的是同一个 <c>%APPDATA%\JingjingReader</c>，避免多处手拼路径出现分叉。
/// </summary>
public static class AppPaths
{
    /// <summary>数据目录名（%APPDATA% 与 %LOCALAPPDATA% 下共用）。</summary>
    public const string DataDirectoryName = "JingjingReader";

    /// <summary>备份文件名（安装前的 .md 关联状态，卸载时据此恢复）。</summary>
    public const string AssocBackupFileName = "assoc-backup.json";

    /// <summary>调试日志文件名。</summary>
    public const string DebugLogFileName = "debug.log";

    /// <summary>
    /// 数据目录 <c>%APPDATA%\JingjingReader</c>；不存在时创建（Store / 备份文件都要求目录存在）。
    /// 路径按当前环境变量实时计算，便于测试/迁移环境复用。
    /// </summary>
    public static string DataDir
    {
        get
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                DataDirectoryName);
            Directory.CreateDirectory(directory);
            return directory;
        }
    }

    /// <summary><c>%APPDATA%\JingjingReader\assoc-backup.json</c>。</summary>
    public static string AssocBackupPath => Path.Combine(DataDir, AssocBackupFileName);

    /// <summary><c>%APPDATA%\JingjingReader\debug.log</c>（spec §7）。</summary>
    public static string DebugLogPath => Path.Combine(DataDir, DebugLogFileName);
}
