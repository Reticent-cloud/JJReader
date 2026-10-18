using System.IO;
using System.Runtime.InteropServices;

namespace JingjingReader;

/// <summary>
/// WebView2 启动失败的自助恢复：
/// 0x800700AA（ERROR_BUSY，资源被占用）常见于上一次异常退出留下的用户数据目录被锁，
/// 或者程序被放在受限制/同步目录里运行。这里提供可测试的「重置用户数据目录」与错误识别纯函数，
/// 由 <see cref="MainWindow"/> 在失败对话框里提供「清除缓存并重试」。
/// </summary>
public static class WebView2Recovery
{
    /// <summary>ERROR_BUSY：WebView2 用户数据目录被其它进程占用（0x800700AA）。</summary>
    public const int ErrorBusy = unchecked((int)0x800700AA);

    /// <summary>异常链上是否有 ERROR_BUSY / COMException 0x800700AA。</summary>
    public static bool IsResourceBusy(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is COMException com && com.HResult == ErrorBusy)
            {
                return true;
            }

            if (current.HResult == ErrorBusy)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// 把用户数据目录改名成 <c>&lt;名字&gt;.bak-yyyyMMddHHmmss</c>，让下次初始化得到干净目录。
    /// 目录不存在时返回 true（等效已重置）；改名失败返回 false（调用方提示用户手动处理）。
    /// </summary>
    public static bool TryResetUserDataFolder(string dataFolder, DateTimeOffset now, out string backupPath)
    {
        backupPath = string.Empty;
        if (string.IsNullOrWhiteSpace(dataFolder))
        {
            return false;
        }

        try
        {
            if (!Directory.Exists(dataFolder))
            {
                return true;
            }

            var parent = Path.GetDirectoryName(dataFolder);
            if (string.IsNullOrWhiteSpace(parent))
            {
                return false;
            }

            var stamp = now.ToLocalTime().ToString("yyyyMMddHHmmss");
            var candidate = Path.Combine(parent, Path.GetFileName(dataFolder) + ".bak-" + stamp);
            for (var suffix = 1; suffix < 100 && Directory.Exists(candidate); suffix++)
            {
                candidate = Path.Combine(parent, Path.GetFileName(dataFolder) + ".bak-" + stamp + "-" + suffix);
            }

            Directory.Move(dataFolder, candidate);
            backupPath = candidate;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
