using System.Diagnostics;
using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 13 wikilink 寻文件：当前目录优先（大小写不敏感、无扩展名补 .md/.markdown/.mdown/.txt）、
/// 广度受限递归子目录、跳过隐藏目录、目录穿越/缺失拒绝，以及附件按文件名精确匹配。
/// 修复波 D：目录与最终文件的重解析点（junction/symlink/AppExecLink）都必须拒绝。
/// 全部用例在 <see cref="TestHelpers.TestDir"/> 的真实临时目录里读写。
/// </summary>
public class NoteResolverTests
{
    private static string Normalized(params string[] parts) => FileHost.NormalizePath(Path.Combine(parts));

    /// <summary>相对路径统一用 / 比较（记录里用 Windows 的 \）。</summary>
    private static string Relative(NoteHit hit) => hit.RelativePath.Replace('\\', '/');

    [Fact]
    public void FindNote_finds_note_in_subdir_case_insensitive()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "子目录"));
        File.WriteAllText(Path.Combine(dir, "子目录", "Note.md"), "# x");

        var hit = NoteResolver.FindNote(dir, "note");

        Assert.NotNull(hit);
        Assert.Equal("子目录/Note.md", Relative(hit!));
        // 返回磁盘上的真实大小写路径，而不是用户输入的大小写
        Assert.Equal(Normalized(dir, "子目录", "Note.md"), hit.FullPath);
    }

    [Fact]
    public void FindNote_finds_current_directory_and_completes_extension()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "标题.md"), "# x");
        File.WriteAllText(Path.Combine(dir, "readme.markdown"), "# x");
        File.WriteAllText(Path.Combine(dir, "notes.txt"), "x");

        Assert.Equal("标题.md", Relative(NoteResolver.FindNote(dir, "标题")!));
        Assert.Equal("标题.md", Relative(NoteResolver.FindNote(dir, "标题.md")!));
        Assert.Equal("readme.markdown", Relative(NoteResolver.FindNote(dir, "readme")!));
        Assert.Equal("notes.txt", Relative(NoteResolver.FindNote(dir, "notes")!));
        // 当前目录优先于子目录：同名文件取当前目录那份
        Directory.CreateDirectory(Path.Combine(dir, "子目录"));
        File.WriteAllText(Path.Combine(dir, "子目录", "标题.md"), "# 另一份");
        Assert.Equal("标题.md", Relative(NoteResolver.FindNote(dir, "标题")!));
    }

    [Fact]
    public void FindNote_is_case_insensitive_and_returns_disk_casing()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "MixedCase.MD"), "# x");

        Assert.Equal("MixedCase.MD", Relative(NoteResolver.FindNote(dir, "mixedcase")!));
        Assert.Equal("MixedCase.MD", Relative(NoteResolver.FindNote(dir, "MIXEDCASE.MD")!));
    }

    [Fact]
    public void FindNote_accepts_relative_subdirectory_target()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "子目录"));
        File.WriteAllText(Path.Combine(dir, "子目录", "Note.md"), "# x");

        Assert.Equal("子目录/Note.md", Relative(NoteResolver.FindNote(dir, @"子目录/note")!));
    }

    [Fact]
    public void FindNote_rejects_traversal_and_missing()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "a.md"), "# x");

        Assert.Null(NoteResolver.FindNote(dir, @"..\..\windows\win.ini"));
        Assert.Null(NoteResolver.FindNote(dir, @"..\a.md"));
        Assert.Null(NoteResolver.FindNote(dir, @"C:\Windows\win.ini"));
        Assert.Null(NoteResolver.FindNote(dir, "不存在"));
        Assert.Null(NoteResolver.FindNote(dir, "a.html"));
        Assert.Null(NoteResolver.FindNote(dir, "   "));
    }

    [Fact]
    public void FindNote_rejects_sibling_directory_prefix()
    {
        var root = TestHelpers.TestDir();
        var dir = Path.Combine(root, "notes");
        Directory.CreateDirectory(dir);
        Directory.CreateDirectory(Path.Combine(root, "notes2"));
        File.WriteAllText(Path.Combine(root, "notes2", "x.md"), "# x");

        // C:\...\notes2 不是 C:\...\notes 的子目录：严格前缀校验
        Assert.Null(NoteResolver.FindNote(dir, @"..\notes2\x.md"));
    }

    [Fact]
    public void FindNote_respects_depth_limit()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "一层", "二层", "三层"));
        File.WriteAllText(Path.Combine(dir, "一层", "One.md"), "# x");
        File.WriteAllText(Path.Combine(dir, "一层", "二层", "Two.md"), "# x");
        File.WriteAllText(Path.Combine(dir, "一层", "二层", "三层", "Deep.md"), "# x");

        // 默认 maxDepth=2：只搜两层子目录
        Assert.Null(NoteResolver.FindNote(dir, "deep"));
        Assert.Null(NoteResolver.FindNote(dir, "deep", 2));
        Assert.NotNull(NoteResolver.FindNote(dir, "deep", 3));
        Assert.Equal("一层/One.md", Relative(NoteResolver.FindNote(dir, "one", 1)!));
        Assert.Equal("一层/二层/Two.md", Relative(NoteResolver.FindNote(dir, "two", 2)!));
        Assert.Null(NoteResolver.FindNote(dir, "one", 0)); // 0：只看当前目录
    }

    [Fact]
    public void FindNote_skips_hidden_directories()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, ".git"));
        File.WriteAllText(Path.Combine(dir, ".git", "Secret.md"), "# x");

        Assert.Null(NoteResolver.FindNote(dir, "secret"));
        // 显式写出隐藏目录路径仍可命中（用户明确指定）
        Assert.Equal(".git/Secret.md", Relative(NoteResolver.FindNote(dir, @".git\secret")!));
    }

    [Fact]
    public void FindNote_returns_null_for_blank_directory()
    {
        Assert.Null(NoteResolver.FindNote("", "a.md"));
        Assert.Null(NoteResolver.FindNote(@"C:\definitely-not-a-real-dir-" + Guid.NewGuid().ToString("N"), "a.md"));
    }

    [Fact]
    public void FindNote_rejects_explicit_paths_through_junctions()
    {
        var docDir = TestHelpers.TestDir();
        var outside = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(outside, "Secret.md"), "# x");
        var link = Path.Combine(docDir, "link");
        if (!TryCreateJunction(link, outside))
        {
            // 与 DirectoryListerTests 同策略：环境不支持就显式失败，不能静默跳过安全用例。
            Assert.Fail("环境不支持创建 junction/symlink，无法验证 reparse 限制");
        }

        // C1：显式 [[link/secret]] 不能借 junction 把「目录内」的字符串前缀指到目录外。
        Assert.Null(NoteResolver.FindNote(docDir, @"link\secret"));
        Assert.Null(NoteResolver.FindNote(docDir, "secret"));
        Assert.Null(OpenTargetResolver.Resolve(docDir, @"link\secret"));
    }

    [Fact]
    public void FindNote_rejects_final_file_that_is_a_reparse_point()
    {
        var (directory, fileName) = ResolveFileReparsePointFixture();

        // 最终文件本身是 symlink/AppExecLink 时同样按 reparse 拒绝（不能只查中间目录段）。
        Assert.Null(NoteResolver.FindNote(directory, fileName));
        Assert.Null(NoteResolver.FindAttachment(directory, fileName));
    }

    /// <summary>
    /// 找一个「文件级重解析点」夹具：优先在临时目录创建 .md 文件符号链接（mklink 或 .NET API）；
    /// 当前账户没有 SeCreateSymbolicLinkPrivilege 且未开开发者模式时，回退到系统自带的应用执行别名
    /// （<c>%LOCALAPPDATA%\Microsoft\WindowsApps</c> 下的 AppExecLink，带 ReparsePoint 属性）。
    /// 两种方式都不可用时显式失败（不能空转通过）。
    /// </summary>
    private static (string Directory, string FileName) ResolveFileReparsePointFixture()
    {
        var dir = TestHelpers.TestDir();
        var target = Path.Combine(dir, "target.md");
        File.WriteAllText(target, "# x");
        var link = Path.Combine(dir, "linked.md");
        if (TryCreateFileLink(link, target))
        {
            return (dir, "linked.md");
        }

        var windowsApps = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft",
            "WindowsApps");
        try
        {
            if (Directory.Exists(windowsApps))
            {
                foreach (var file in Directory.EnumerateFiles(windowsApps))
                {
                    if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                    {
                        return (windowsApps, Path.GetFileName(file));
                    }
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 读不到 WindowsApps：继续走显式失败。
        }

        Assert.Fail("环境无法创建文件符号链接，也找不到现有文件重解析点，无法验证最终文件 reparse 限制");
        return default;
    }

    /// <summary>创建文件符号链接（不要求管理员/开发者模式的环境才成功）；失败返回 false。</summary>
    private static bool TryCreateFileLink(string link, string target)
    {
        try
        {
            var startInfo = new ProcessStartInfo("cmd.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add("mklink");
            startInfo.ArgumentList.Add(link);
            startInfo.ArgumentList.Add(target);
            using var process = Process.Start(startInfo);
            if (process is not null)
            {
                process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
                if (process.WaitForExit(5000) && process.ExitCode == 0 && File.Exists(link))
                {
                    return true;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // 回退到 .NET API。
        }

        try
        {
            File.CreateSymbolicLink(link, target);
            return File.Exists(link);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                               or PlatformNotSupportedException or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>用 <c>mklink /J</c> 创建目录 junction（不需要管理员权限）；失败返回 false。</summary>
    private static bool TryCreateJunction(string link, string target)
    {
        try
        {
            var startInfo = new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return false;
            }

            process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            return process.WaitForExit(5000) && process.ExitCode == 0 && Directory.Exists(link);
        }
        catch (Exception exception) when (exception is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }

    [Fact]
    public void FindAttachment_finds_file_by_exact_name_in_subdir()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "附件"));
        File.WriteAllText(Path.Combine(dir, "附件", "图 1.png"), "x");

        var hit = NoteResolver.FindAttachment(dir, "图 1.png");

        Assert.NotNull(hit);
        Assert.Equal("附件/图 1.png", Relative(hit!));
        Assert.Equal(Normalized(dir, "附件", "图 1.png"), hit.FullPath);
    }

    [Fact]
    public void FindAttachment_matches_full_file_name_only()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "附件"));
        File.WriteAllText(Path.Combine(dir, "附件", "report.pdf"), "x");

        Assert.Null(NoteResolver.FindAttachment(dir, "report")); // 不补扩展名
        Assert.Null(NoteResolver.FindAttachment(dir, "report.pdf.bak"));
        Assert.NotNull(NoteResolver.FindAttachment(dir, "REPORT.PDF")); // 文件名大小写不敏感
        Assert.Null(NoteResolver.FindAttachment(dir, "missing.png"));
    }

    [Fact]
    public void FindAttachment_rejects_traversal_and_missing_directory()
    {
        var dir = TestHelpers.TestDir();

        Assert.Null(NoteResolver.FindAttachment(dir, @"..\..\windows\win.ini"));
        Assert.Null(NoteResolver.FindAttachment(dir, @"C:\Windows\win.ini"));
        Assert.Null(NoteResolver.FindAttachment(dir, ""));
        Assert.Null(NoteResolver.FindAttachment(dir, "   "));
    }
}
