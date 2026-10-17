using System.IO;
using System.Text;

namespace JingjingReader;

/// <summary>
/// 调试日志：追加写入 <c>%APPDATA%\JingjingReader\debug.log</c>（spec §7）。
/// 任何写入失败都静默丢弃——日志绝不能影响阅读器主流程；也不使用 Windows 事件日志。
/// </summary>
internal static class DebugLog
{
    private static readonly object Gate = new();
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>日志路径按当前环境变量实时计算（测试/迁移环境不需要缓存）。</summary>
    private static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "JingjingReader",
        "debug.log");

    /// <summary>追加一行带本地时间戳的日志；失败静默。</summary>
    public static void Write(string message)
    {
        try
        {
            var path = LogPath;
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var line = $"{DateTimeOffset.Now:yyyy-MM-dd'T'HH:mm:ss.fffzzz} {message}{Environment.NewLine}";
            lock (Gate)
            {
                File.AppendAllText(path, line, Utf8NoBom);
            }
        }
        catch (Exception)
        {
            // 磁盘满、无权限、APPDATA 不可写：日志失败一律静默（spec §6.2「写盘失败只记录日志，不弹窗」）。
        }
    }
}
