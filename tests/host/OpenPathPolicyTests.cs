using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 评审 C1：openFile / openRecent / openTreeFile 的准入纯函数。
/// 覆盖绝对路径、UNC、盘符相对、<c>..</c>、合法相对路径、最近列表命中/未命中、
/// 浏览根内/外/同前缀兄弟目录。
/// </summary>
public class OpenPathPolicyTests
{
    [Theory]
    [InlineData("笔记.md")]
    [InlineData("子目录/笔记.md")]
    [InlineData(@"子目录\笔记.md")]
    [InlineData("./note.md")]
    [InlineData("a b/文件 名称.md")]
    [InlineData("a..b.md")]
    [InlineData("img/图 1.png")]
    public void Content_target_allows_plain_relative_paths(string relPath)
    {
        Assert.True(OpenPathPolicy.IsContentTargetAllowed(relPath), relPath);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(@"C:\Users\Admin\.ssh\id_rsa")]
    [InlineData("c:/users/admin/.ssh/id_rsa")]
    [InlineData(@"\\attacker\share\secret.md")]
    [InlineData(@"\\?\C:\notes\a.md")]
    [InlineData(@"\\.\C:\notes\a.md")]
    [InlineData("//attacker/share/secret.md")]
    [InlineData(@"C:relative.md")]
    [InlineData(@"C:")]
    [InlineData(@"\absolute.md")]
    [InlineData("/absolute.md")]
    [InlineData("../escape.md")]
    [InlineData(@"sub\..\escape.md")]
    [InlineData("..")]
    [InlineData("a.md:stream")]
    [InlineData("bad\0name.md")]
    public void Content_target_rejects_absolute_unc_drive_relative_and_traversal(string? relPath)
    {
        Assert.False(OpenPathPolicy.IsContentTargetAllowed(relPath), relPath);
    }

    [Fact]
    public void Recent_path_matches_normalized_path_case_insensitively()
    {
        var dir = TestHelpers.TestDir();
        var file = Path.Combine(dir, "Note.md");
        File.WriteAllText(file, "# x");
        var normalized = FileHost.NormalizePath(file);
        var recent = new[]
        {
            new RecentEntry(Path.Combine(dir, "other.md"), "2026-10-18T00:00:00Z", 1),
            new RecentEntry(file.ToUpperInvariant(), "2026-10-18T00:00:00Z", 1),
        };

        Assert.True(OpenPathPolicy.IsRecentPath(normalized, recent));
    }

    [Fact]
    public void Recent_path_rejects_paths_not_in_the_list()
    {
        var dir = TestHelpers.TestDir();
        var recent = new[] { new RecentEntry(Path.Combine(dir, "a.md"), "2026-10-18T00:00:00Z", 1) };

        Assert.False(OpenPathPolicy.IsRecentPath(FileHost.NormalizePath(Path.Combine(dir, "b.md")), recent));
        Assert.False(OpenPathPolicy.IsRecentPath(FileHost.NormalizePath(Path.Combine(dir, "a.md")), null));
        Assert.False(OpenPathPolicy.IsRecentPath(null, recent));
        Assert.False(OpenPathPolicy.IsRecentPath(@"relative\a.md", recent));
    }

    [Fact]
    public void Recent_path_skips_invalid_entries_without_throwing()
    {
        var dir = TestHelpers.TestDir();
        var file = Path.Combine(dir, "a.md");
        var recent = new[]
        {
            new RecentEntry("bad\0path", "2026-10-18T00:00:00Z", 1),
            new RecentEntry(file, "2026-10-18T00:00:00Z", 1),
        };

        Assert.True(OpenPathPolicy.IsRecentPath(FileHost.NormalizePath(file), recent));
    }

    [Theory]
    [InlineData(@"C:\notes", @"C:\notes\a.md", true)]
    [InlineData(@"C:\notes", @"c:\NOTES\sub\b.md", true)]
    [InlineData(@"C:\notes", @"C:\notes2\a.md", false)]
    [InlineData(@"C:\notes", @"C:\other\a.md", false)]
    [InlineData(@"C:\notes", @"C:\notes", false)]
    [InlineData(@"C:\notes", @"..\a.md", false)]
    [InlineData(null, @"C:\notes\a.md", false)]
    [InlineData(@"C:\notes", null, false)]
    public void Inside_browse_root_requires_strict_prefix(string? root, string? path, bool expected)
    {
        Assert.Equal(expected, OpenPathPolicy.IsInsideBrowseRoot(root, path));
    }
}
