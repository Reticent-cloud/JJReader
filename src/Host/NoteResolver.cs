using System.IO;

namespace JingjingReader;

/// <summary>一次寻文件的结果：磁盘上的真实大小写绝对路径 + 相对文档目录的路径（<c>\</c> 分隔）。</summary>
public sealed record NoteHit(string FullPath, string RelativePath);

/// <summary>
/// wikilink / 附件的寻文件（Task 13）：
/// 先当前目录（大小写不敏感；笔记名无扩展名时依次补 .md/.markdown/.mdown/.txt），
/// 再按 <paramref name="maxDepth"/> 层子目录广度优先查找；跳过隐藏目录与不可读目录；
/// 所有目标先经 <see cref="FileHost.ResolveInside"/> 校验，越界（含 <c>..</c>、跨盘、同前缀兄弟目录）一律 null。
/// </summary>
public static class NoteResolver
{
    /// <summary>无扩展名时依次尝试的笔记扩展名（与 <see cref="FileHost.IsMarkdown"/> 的口径一致）。</summary>
    private static readonly string[] NoteExtensions = [".md", ".markdown", ".mdown", ".txt"];

    /// <summary>按笔记名找文件：大小写不敏感、无扩展名补笔记扩展名、最多搜 <paramref name="maxDepth"/> 层子目录。</summary>
    public static NoteHit? FindNote(string docDir, string target, int maxDepth = 2)
        => Find(docDir, target, maxDepth, completeNoteExtension: true);

    /// <summary>按文件名精确找附件：不补扩展名，其余规则与 <see cref="FindNote"/> 相同。</summary>
    public static NoteHit? FindAttachment(string docDir, string target, int maxDepth = 2)
        => Find(docDir, target, maxDepth, completeNoteExtension: false);

    /// <summary>
    /// 把「已确认存在」的相对路径恢复成磁盘上的真实大小写（供 openFile 的精确命中复用，
    /// 避免同一文件因用户输入大小写不同产生两条最近记录）。越界/不存在返回 null。
    /// </summary>
    internal static NoteHit? RecoverExisting(string docDir, string relative)
    {
        if (string.IsNullOrWhiteSpace(docDir) || string.IsNullOrWhiteSpace(relative))
        {
            return null;
        }

        var trimmed = relative.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        string root;
        try
        {
            root = PlainPath(FileHost.NormalizePath(docDir));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }

        var resolved = FileHost.ResolveInside(root, trimmed);
        return resolved is null ? null : ResolveExisting(root, Path.GetRelativePath(root, PlainPath(resolved)));
    }

    private static NoteHit? Find(string docDir, string target, int maxDepth, bool completeNoteExtension)
    {
        if (string.IsNullOrWhiteSpace(docDir) || string.IsNullOrWhiteSpace(target) || maxDepth < 0)
        {
            return null;
        }

        string root;
        try
        {
            // NormalizePath 统一盘符/分隔符，也负责给超长路径加 \\?\ 前缀；校验仍走 FileHost 的严格前缀检查。
            root = PlainPath(FileHost.NormalizePath(docDir));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }

        if (!Directory.Exists(root))
        {
            return null;
        }

        var trimmed = target.Trim();
        if (trimmed.Length == 0 || Path.IsPathFullyQualified(trimmed))
        {
            // wikilink 目标是笔记名/相对路径；盘符/UNC 绝对路径一律拒绝，避免绕过文档目录
            return null;
        }

        var resolved = FileHost.ResolveInside(root, trimmed);
        if (resolved is null)
        {
            return null;
        }

        var relative = Path.GetRelativePath(root, PlainPath(resolved));
        var candidates = Candidates(relative, completeNoteExtension);

        // ① 当前目录（目标带子目录时也支持，如 [[子目录/Note]]）
        foreach (var candidate in candidates)
        {
            if (ResolveExisting(root, candidate) is { } direct)
            {
                return direct;
            }
        }

        // ② 广度优先递归子目录：层数 1..maxDepth
        return FindInSubdirectories(root, candidates, maxDepth);
    }

    /// <summary>候选相对路径：有扩展名只试原样；无扩展名时按笔记扩展名依次补全。</summary>
    private static List<string> Candidates(string relative, bool completeNoteExtension)
    {
        if (!completeNoteExtension || Path.GetExtension(relative).Length > 0)
        {
            return [relative];
        }

        var candidates = new List<string>(NoteExtensions.Length);
        foreach (var extension in NoteExtensions)
        {
            candidates.Add(relative + extension);
        }

        return candidates;
    }

    private static NoteHit? FindInSubdirectories(string root, IReadOnlyList<string> candidates, int maxDepth)
    {
        var queue = new Queue<(string Directory, string Prefix, int Depth)>();
        queue.Enqueue((root, string.Empty, 0));
        while (queue.Count > 0)
        {
            var (directory, prefix, depth) = queue.Dequeue();
            if (depth >= maxDepth)
            {
                continue;
            }

            foreach (var subdirectory in SafeGetDirectories(directory))
            {
                if (IsHiddenOrReparsePoint(subdirectory))
                {
                    continue;
                }

                var name = Path.GetFileName(subdirectory);
                var subPrefix = prefix.Length == 0 ? name : prefix + "\\" + name;
                foreach (var candidate in candidates)
                {
                    var match = ResolveCandidateInSubdirectory(root, subdirectory, subPrefix, candidate);
                    if (match is not null)
                    {
                        return match;
                    }
                }

                queue.Enqueue((subdirectory, subPrefix, depth + 1));
            }
        }

        return null;
    }

    /// <summary>
    /// 在已枚举到的子目录里找候选：常见情形（候选只有文件名）直接比对文件名，避免重新逐段解析；
    /// 候选本身带子目录时（[[子目录/Note]]）再按完整相对路径逐段确认。
    /// </summary>
    private static NoteHit? ResolveCandidateInSubdirectory(string root, string subdirectory, string subPrefix, string candidate)
    {
        var candidateDirectory = Path.GetDirectoryName(candidate);
        if (string.IsNullOrEmpty(candidateDirectory))
        {
            var file = FindFile(subdirectory, candidate);
            // 文件级重解析点（symlink/AppExecLink 等）与目录一样拒绝：不能只查中间目录段。
            return file is null || IsReparsePoint(file)
                ? null
                : new NoteHit(file, Path.GetRelativePath(root, file));
        }

        return ResolveExisting(root, subPrefix + "\\" + candidate);
    }

    /// <summary>
    /// 把相对 <paramref name="root"/> 的路径逐段按磁盘真实大小写恢复并确认存在；
    /// 任一段不存在/不可读都返回 null。返回真实大小写的绝对路径与相对路径。
    /// </summary>
    private static NoteHit? ResolveExisting(string root, string relative)
    {
        var segments = relative.Replace('/', '\\').Split('\\', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0)
        {
            return null;
        }

        var current = root;
        for (var index = 0; index < segments.Length; index += 1)
        {
            var isFile = index == segments.Length - 1;
            var match = isFile ? FindFile(current, segments[index]) : FindDirectory(current, segments[index]);
            if (match is null)
            {
                return null;
            }

            // 与 BFS 路径一致的重解析点检查（C1）：显式目标也逐段拒绝 junction/symlink，
            // 否则「文档目录内」的字符串前缀可以被重定向到目录外。隐藏目录仍允许显式指定。
            // 修复波 D：最终文件本身也要查（文件级 symlink/AppExecLink 不能绕过）。
            if (IsReparsePoint(match))
            {
                return null;
            }

            current = match;
        }

        return new NoteHit(current, Path.GetRelativePath(root, current));
    }

    /// <summary>在目录里按大小写不敏感找文件，返回磁盘上的真实名称路径；找不到/不可读返回 null。</summary>
    private static string? FindFile(string directory, string name)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                if (string.Equals(Path.GetFileName(file), name, StringComparison.OrdinalIgnoreCase))
                {
                    return file;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // 不可读目录按「没有」处理
        }

        return null;
    }

    /// <summary>在目录里按大小写不敏感找子目录，返回磁盘上的真实名称路径；找不到/不可读返回 null。</summary>
    private static string? FindDirectory(string directory, string name)
    {
        foreach (var subdirectory in SafeGetDirectories(directory))
        {
            if (string.Equals(Path.GetFileName(subdirectory), name, StringComparison.OrdinalIgnoreCase))
            {
                return subdirectory;
            }
        }

        return null;
    }

    private static string[] SafeGetDirectories(string directory)
    {
        try
        {
            return Directory.GetDirectories(directory);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return [];
        }
    }

    /// <summary>跳过以 <c>.</c> 开头的目录与带隐藏/重解析点（符号链接可能成环）标记的目录。</summary>
    private static bool IsHiddenOrReparsePoint(string directory)
    {
        var name = Path.GetFileName(directory);
        if (name.StartsWith('.'))
        {
            return true;
        }

        return HasAnyAttribute(directory, FileAttributes.Hidden | FileAttributes.ReparsePoint);
    }

    /// <summary>目录是否是重解析点（junction/符号链接）；读属性失败按「是」处理，安全侧失败。</summary>
    private static bool IsReparsePoint(string directory)
        => HasAnyAttribute(directory, FileAttributes.ReparsePoint);

    private static bool HasAnyAttribute(string directory, FileAttributes flags)
    {
        try
        {
            var attributes = File.GetAttributes(directory);
            return (attributes & flags) != 0;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return true;
        }
    }

    /// <summary>去掉 <c>\\?\</c> / <c>\\?\UNC\</c> / <c>\\.\</c> 扩展前缀（Path 组合/相对路径计算用普通形式）。</summary>
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
