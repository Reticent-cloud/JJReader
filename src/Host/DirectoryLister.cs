using System.IO;

namespace JingjingReader;

/// <summary>
/// 文件树侧栏的目录枚举（Task 14 的纯函数，真实临时目录即可测试）：
/// 只列子目录与可渲染的 Markdown 文本扩展名；目录在前、同类按名称（OrdinalIgnoreCase）排序；
/// 跳过隐藏/系统/重解析点与单个不可读项；相对路径统一用 <c>/</c> 分隔。
/// 达到 <see cref="DefaultMaxEntries"/> 上限立即停止枚举（超大目录不整目录遍历）。
/// 路径限制在浏览根内：越界（含 <c>..</c>、跨盘、同前缀兄弟目录）抛 <see cref="UnauthorizedAccessException"/>；
/// 子路径中的重解析点（junction/symlink）同样拒绝，避免从根内路径借道逃逸。
/// </summary>
public static class DirectoryLister
{
    /// <summary>单次列出的条目上限（防超大目录把 JSON 消息与 DOM 撑爆；超出静默截断）。</summary>
    public const int DefaultMaxEntries = 2000;

    private static readonly FileAttributes SkippedAttributes =
        FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint;

    /// <summary>
    /// 列出 <paramref name="browseRoot"/> 下 <paramref name="relativePath"/> 目录的直接子项。
    /// <paramref name="relativePath"/> 为空白 / <c>"."</c> 时表示浏览根本身。
    /// 返回项：<c>Name</c> 名称、<c>IsDir</c> 是否目录、<c>RelPath</c> 相对浏览根的路径（<c>/</c> 分隔）。
    /// </summary>
    public static IReadOnlyList<(string Name, bool IsDir, string RelPath)> List(
        string browseRoot,
        string? relativePath,
        int maxEntries = DefaultMaxEntries)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(browseRoot);
        if (maxEntries <= 0)
        {
            return Array.Empty<(string Name, bool IsDir, string RelPath)>();
        }

        // 枚举路径保留 \\?\ 前缀（评审 WARN）：>255 的根/目录用带前缀路径枚举才稳；
        // 普通（去前缀）形式只用于「包含性比较 / 相对路径计算」，不能反过来先丢前缀再枚举。
        var root = PlainPath(FileHost.NormalizePath(browseRoot));
        var relative = (relativePath ?? string.Empty).Trim();
        var target = relative.Length == 0 || relative == "."
            ? root
            : FileHost.ResolveInside(root, relative)
                ?? throw new UnauthorizedAccessException($"路径越出浏览根：{relativePath}");

        EnsureNoReparsePoint(root, target);

        var entries = new List<(string Name, bool IsDir, string RelPath)>();
        foreach (var info in EnumerateSafely(new DirectoryInfo(FileHost.NormalizePath(target))))
        {
            string name;
            FileAttributes attributes;
            try
            {
                name = info.Name;
                attributes = info.Attributes;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // 单个条目读属性失败（损坏/被占用/权限被撤销）：跳过，不影响其余条目
                continue;
            }

            if ((attributes & SkippedAttributes) != 0 || name.StartsWith('.'))
            {
                continue;
            }

            var isDir = (attributes & FileAttributes.Directory) != 0;
            if (!isDir && !FileHost.IsMarkdown(name))
            {
                continue;
            }

            // info.FullName 可能带 \\?\ 前缀：先归一成普通路径再算相对 root 的路径（只比较，不再用于枚举）。
            var relPath = Path.GetRelativePath(root, PlainPath(info.FullName)).Replace('\\', '/');
            entries.Add((name, isDir, relPath));

            if (entries.Count >= maxEntries)
            {
                // 评审 Minor 5：达到上限立即停止枚举，超大目录不再为「排序后截断」继续遍历/统计。
                break;
            }
        }

        // 目录在前、同类按名称排序；入口处已按上限截断，这里只排序本次收集到的条目。
        return entries
            .OrderByDescending(entry => entry.IsDir)
            .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// 逐段检查 target（相对 root）不经过任何重解析点。浏览根本身允许是 junction（用户明确选中的目录），
    /// 但其下的子路径不允许借道，否则「根内相对路径」可能实际读到根外内容。
    /// 不存在的路径交给后续枚举抛标准异常（DirectoryNotFoundException 由调用方转 toast）。
    /// </summary>
    private static void EnsureNoReparsePoint(string root, string target)
    {
        var relative = Path.GetRelativePath(root, target);
        if (relative == "." || relative.Length == 0)
        {
            return;
        }

        var current = root;
        foreach (var segment in relative.Split(
                     [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                     StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            try
            {
                // 属性查询用带 \\?\ 前缀的规范形式（>255 的子路径同样可靠；root/target 本身只用于拼接与比较）。
                if ((File.GetAttributes(FileHost.NormalizePath(current)) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new UnauthorizedAccessException($"路径包含重解析点：{segment}");
                }
            }
            catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// 安全枚举：目录本身不可读时异常向上抛（调用方 toast）；枚举到一半失败（个别条目不可读）时
    /// 保留已读到的条目并结束，不让一个坏条目吞掉整次列表。
    /// </summary>
    private static IEnumerable<FileSystemInfo> EnumerateSafely(DirectoryInfo directory)
    {
        using var enumerator = directory.EnumerateFileSystemInfos().GetEnumerator();
        var yielded = false;
        while (true)
        {
            FileSystemInfo? current = null;
            try
            {
                if (!enumerator.MoveNext())
                {
                    break;
                }

                current = enumerator.Current;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
            {
                // 第一个条目就读不到 = 目录本身不可读：交给调用方 toast；
                // 枚举到一半才失败 = 个别条目损坏：保留已读到的条目，结束本次列表。
                if (!yielded)
                {
                    throw;
                }

                yield break;
            }

            if (current is null)
            {
                yield break;
            }

            yielded = true;
            yield return current;
        }
    }

    /// <summary>去掉 <c>\\?\</c> / <c>\\?\UNC\</c> / <c>\\.\</c> 扩展前缀（与 FileHost/NoteResolver 口径一致）。</summary>
    private static string PlainPath(string path)
    {
        const string extendedUncPrefix = @"\\?\UNC\";
        const string extendedPrefix = @"\\?\";
        const string devicePrefix = @"\\.\";

        if (path.StartsWith(extendedUncPrefix, StringComparison.Ordinal))
        {
            return @"\\" + path[extendedUncPrefix.Length..];
        }

        if (path.StartsWith(extendedPrefix, StringComparison.Ordinal))
        {
            return path[extendedPrefix.Length..];
        }

        return path.StartsWith(devicePrefix, StringComparison.Ordinal)
            ? path[devicePrefix.Length..]
            : path;
    }
}
