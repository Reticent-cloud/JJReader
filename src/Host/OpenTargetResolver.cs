using System.IO;

namespace JingjingReader;

/// <summary>
/// openFile 的相对目标解析（Task 13）：①文档目录内的精确路径；②无扩展名时补 <c>.md</c>；
/// ③委托 <see cref="NoteResolver.FindNote"/>（大小写不敏感、递归子目录）。
/// 绝对路径由调用方按既有语义直接打开；越界/缺失返回 null。
/// </summary>
public static class OpenTargetResolver
{
    /// <summary>wikilink 默认搜索层数（与 <see cref="NoteResolver.FindNote"/> 的默认值一致）。</summary>
    private const int DefaultMaxDepth = 2;

    /// <summary>
    /// 把前端传来的相对目标解析成文档目录内的绝对路径；解析不出（越界/缺失/参数非法）返回 null。
    /// 绝对目标只接受落在 <paramref name="docDir"/> 内且真实存在的文件。
    /// </summary>
    public static string? Resolve(string docDir, string relPath)
    {
        if (string.IsNullOrWhiteSpace(docDir) || string.IsNullOrWhiteSpace(relPath))
        {
            return null;
        }

        var target = relPath.Trim();
        if (target.Length == 0)
        {
            return null;
        }

        // ① 精确路径（绝对路径同样要求落在文档目录内）；命中后恢复磁盘大小写。
        // 恢复失败（含路径段是隐藏目录/重解析点）时不再回退到未校验的 direct：否则 junction
        // 可以把「文档目录内」的字符串前缀指到目录外，绕过 containment。
        var direct = FileHost.ResolveInside(docDir, target);
        if (direct is not null && File.Exists(direct))
        {
            return NoteResolver.RecoverExisting(docDir, target)?.FullPath;
        }

        if (Path.IsPathFullyQualified(target))
        {
            // 越出文档目录的绝对路径不再往下猜（②③ 只服务相对笔记名）
            return null;
        }

        // ② [[笔记]] 常见写法：无扩展名时补 .md
        if (Path.GetExtension(target).Length == 0)
        {
            var withMarkdownExtension = target + ".md";
            var resolved = FileHost.ResolveInside(docDir, withMarkdownExtension);
            if (resolved is not null && File.Exists(resolved))
            {
                return NoteResolver.RecoverExisting(docDir, withMarkdownExtension)?.FullPath;
            }
        }

        // ③ 大小写不敏感 + 递归子目录（NoteResolver 自己再做一次越界校验）
        return NoteResolver.FindNote(docDir, target, DefaultMaxDepth)?.FullPath;
    }
}
