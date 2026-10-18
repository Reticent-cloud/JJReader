using System.IO;

namespace JingjingReader;

/// <summary>
/// 打开路径的准入策略（评审 C1）：前端消息里的路径都不可信，先过纯函数校验再触盘。
/// 三类来源分开：内容内 wikilink/附件只允许文档目录内的**相对路径**；
/// 最近文件只允许 recent.json 里归一化后命中的条目；文件树只允许浏览根内的文件。
/// </summary>
public static class OpenPathPolicy
{
    /// <summary>
    /// 内容内目标（wikilink / 附件）是否允许交给 <see cref="OpenTargetResolver"/> 解析。
    /// 拒绝绝对路径、UNC（<c>\\server\share</c>）、盘符相对（<c>C:foo</c>）、
    /// 根相对（<c>\foo</c> / <c>/foo</c>）、扩展/设备前缀（<c>\\?\</c> / <c>\\.\</c>）、
    /// 含 <c>..</c> 的路径段、以及任何含 <c>:</c>（NTFS 数据流）的路径。
    /// 合法的相对路径（<c>笔记.md</c>、<c>子目录/笔记.md</c>、<c>./x.md</c>）返回 true。
    /// </summary>
    public static bool IsContentTargetAllowed(string? relPath)
    {
        if (string.IsNullOrWhiteSpace(relPath))
        {
            return false;
        }

        var target = relPath.Trim();
        if (target.Length == 0)
        {
            return false;
        }

        // 控制字符（含 NUL）不是合法文件名的一部分，也会让 Path API 抛异常。
        foreach (var ch in target)
        {
            if (char.IsControl(ch))
            {
                return false;
            }
        }

        // \\server\share、//host/share、\\?\C:\、\\.\ 等：绝对/UNC/设备命名空间一律拒绝。
        if (target.StartsWith(@"\\", StringComparison.Ordinal)
            || target.StartsWith("//", StringComparison.Ordinal))
        {
            return false;
        }

        // C:\dir（绝对）与 C:dir（盘符相对）：冒号在 Windows 相对文件名里本就非法（ADS 也用冒号）。
        if (target.Contains(':'))
        {
            return false;
        }

        // \dir / /dir（根相对，相对的是当前盘符根）
        if (Path.IsPathRooted(target) || Path.IsPathFullyQualified(target))
        {
            return false;
        }

        // 目录穿越：OpenTargetResolver/ResolveInside 也会折叠后校验，这里提前拒绝更明确。
        foreach (var segment in target.Split('\\', '/'))
        {
            if (segment == "..")
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// openRecent 的准入：<paramref name="normalizedPath"/>（已 <see cref="FileHost.NormalizePath"/>）
    /// 必须与最近列表里某条记录归一化后大小写不敏感相等。最近列表里的坏路径跳过，绝不抛异常。
    /// </summary>
    public static bool IsRecentPath(string? normalizedPath, IEnumerable<RecentEntry>? recent)
    {
        if (string.IsNullOrWhiteSpace(normalizedPath) || recent is null)
        {
            return false;
        }

        try
        {
            if (!Path.IsPathFullyQualified(normalizedPath))
            {
                return false;
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }

        foreach (var entry in recent)
        {
            if (entry is null || string.IsNullOrWhiteSpace(entry.Path))
            {
                continue;
            }

            try
            {
                if (string.Equals(FileHost.NormalizePath(entry.Path), normalizedPath, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
            {
                // recent.json 里的历史坏路径：跳过，不影响其它条目
            }
        }

        return false;
    }

    /// <summary>
    /// openTreeFile 的准入：<paramref name="absPath"/> 归一化后必须严格位于浏览根内
    /// （同前缀兄弟目录 <c>C:\notes2</c> 不算在 <c>C:\notes</c> 内）。未选择浏览根 / 路径非法一律 false。
    /// </summary>
    public static bool IsInsideBrowseRoot(string? browseRoot, string? absPath)
    {
        if (string.IsNullOrWhiteSpace(browseRoot) || string.IsNullOrWhiteSpace(absPath))
        {
            return false;
        }

        try
        {
            return FileHost.ResolveInside(browseRoot, absPath) is not null;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }
}
