using System.IO;
using System.Text;

namespace JingjingReader;

/// <summary>
/// 调试日志：追加写入 <c>%APPDATA%\JingjingReader\debug.log</c>（spec §7）。
/// 任何写入失败都静默丢弃——日志绝不能影响阅读器主流程；也不使用 Windows 事件日志。
/// M2：单文件超过 256 KB 时滚动为 <c>debug.log.1</c> / <c>debug.log.2</c>，最多保留 3 份。
/// </summary>
internal static class DebugLog
{
    /// <summary>单份日志上限（spec §7：3 × 256 KB）。</summary>
    internal const long MaxFileBytes = 256 * 1024;

    /// <summary>滚动保留的份数：debug.log + debug.log.1 + debug.log.2。</summary>
    internal const int MaxFiles = 3;

    private static readonly object Gate = new();
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>日志路径统一由 <see cref="AppPaths"/> 计算（与 Store / 备份文件同一数据目录）。</summary>
    private static string LogPath => AppPaths.DebugLogPath;

    /// <summary>追加一行带本地时间戳的日志；失败静默。</summary>
    public static void Write(string message) => WriteTo(LogPath, message);

    /// <summary>
    /// 追加一行到指定路径（测试注入用；产品代码走 <see cref="Write(string)"/>）。
    /// 写前检查大小：超过 <see cref="MaxFileBytes"/> 先滚动，避免日志无限增长。
    /// </summary>
    internal static void WriteTo(string path, string message)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var line = $"{DateTimeOffset.Now:yyyy-MM-dd'T'HH:mm:ss.fffzzz} {message}{Environment.NewLine}";
            lock (Gate)
            {
                if (ShouldRoll(path, Encoding.UTF8.GetByteCount(line)))
                {
                    Roll(path);
                }

                File.AppendAllText(path, line, Utf8NoBom);
            }
        }
        catch (Exception)
        {
            // 磁盘满、无权限、APPDATA 不可写：日志失败一律静默（spec §6.2「写盘失败只记录日志，不弹窗」）。
        }
    }

    /// <summary>当前文件已满（再写这一行会超上限）时滚动。</summary>
    private static bool ShouldRoll(string path, int incomingBytes)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists && info.Length + incomingBytes > MaxFileBytes;
        }
        catch (Exception)
        {
            // 读不到大小就不滚动，最多多写一点
            return false;
        }
    }

    /// <summary>
    /// debug.log → .1 → .2（超出 <see cref="MaxFiles"/> 的最旧一份删除）。
    /// 每一步失败只放弃对应步骤：滚动是尽力而为，不能阻断本次日志写入。
    /// </summary>
    private static void Roll(string path)
    {
        for (var index = MaxFiles - 1; index >= 2; index -= 1)
        {
            TryDelete(ArchivePath(path, index));
        }

        for (var index = MaxFiles - 2; index >= 1; index -= 1)
        {
            TryMove(ArchivePath(path, index), ArchivePath(path, index + 1));
        }

        TryMove(path, ArchivePath(path, 1));
    }

    private static string ArchivePath(string path, int index) => $"{path}.{index}";

    private static void TryMove(string source, string destination)
    {
        try
        {
            if (File.Exists(source))
            {
                File.Move(source, destination, overwrite: true);
            }
        }
        catch (Exception)
        {
            // 备份移动失败（被占用等）：继续写当前文件，不阻断日志
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception)
        {
            // 删除失败不影响后续滚动/写入
        }
    }
}
