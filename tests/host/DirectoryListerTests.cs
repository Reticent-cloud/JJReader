using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// DirectoryLister（Task 14）：文件树侧栏的目录枚举纯函数。
/// 全部用例在真实临时目录树上运行（TestHelpers.TestDir）：排序、扩展名过滤、隐藏/系统/重解析点跳过、
/// 子路径与相对路径、越界拒绝、根 "" 语义与 maxEntries 截断。
/// </summary>
public class DirectoryListerTests
{
    private static string CreateFile(string directory, string name)
    {
        var path = Path.Combine(directory, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "x");
        return path;
    }

    private static string CreateDirectory(string directory, string name)
    {
        var path = Path.Combine(directory, name);
        Directory.CreateDirectory(path);
        return path;
    }

    [Fact]
    public void List_root_puts_directories_first_then_sorts_names_case_insensitively()
    {
        var root = TestHelpers.TestDir();
        CreateFile(root, "b.md");
        CreateFile(root, "A.MD");
        CreateDirectory(root, "zeta");
        CreateDirectory(root, "Alpha");

        var entries = DirectoryLister.List(root, string.Empty);

        Assert.Equal(new[] { "Alpha", "zeta", "A.MD", "b.md" }, entries.Select(entry => entry.Name));
        Assert.Equal(new[] { true, true, false, false }, entries.Select(entry => entry.IsDir));
        // 根目录的直接子项：relPath 就是名称本身，且统一用 / 分隔
        Assert.All(entries, entry => Assert.Equal(entry.Name, entry.RelPath));
    }

    [Fact]
    public void List_filters_markdown_extensions_case_insensitively()
    {
        var root = TestHelpers.TestDir();
        CreateFile(root, "a.md");
        CreateFile(root, "B.MARKDOWN");
        CreateFile(root, "c.Mdown");
        CreateFile(root, "d.TxT");
        CreateFile(root, "image.png");
        CreateFile(root, "notes.mdx");
        CreateFile(root, "page.html");
        CreateFile(root, "README");

        var entries = DirectoryLister.List(root, string.Empty);

        Assert.Equal(
            new[] { "a.md", "B.MARKDOWN", "c.Mdown", "d.TxT" },
            entries.Select(entry => entry.Name));
        Assert.All(entries, entry => Assert.False(entry.IsDir));
    }

    [Fact]
    public void List_skips_hidden_system_and_dot_prefixed_entries()
    {
        var root = TestHelpers.TestDir();
        CreateFile(root, "visible.md");
        var hiddenFile = CreateFile(root, "hidden.md");
        var systemFile = CreateFile(root, "system.md");
        var hiddenDir = CreateDirectory(root, "hidden-dir");
        CreateDirectory(root, "visible-dir");
        CreateFile(root, ".dot-file.md");
        CreateDirectory(root, ".dot-dir");

        var hiddenFileAttributes = File.GetAttributes(hiddenFile);
        var systemFileAttributes = File.GetAttributes(systemFile);
        var hiddenDirAttributes = File.GetAttributes(hiddenDir);
        File.SetAttributes(hiddenFile, hiddenFileAttributes | FileAttributes.Hidden);
        File.SetAttributes(systemFile, systemFileAttributes | FileAttributes.System);
        File.SetAttributes(hiddenDir, hiddenDirAttributes | FileAttributes.Hidden);

        try
        {
            var entries = DirectoryLister.List(root, string.Empty);

            Assert.Equal(new[] { "visible-dir", "visible.md" }, entries.Select(entry => entry.Name));
        }
        finally
        {
            File.SetAttributes(hiddenFile, hiddenFileAttributes);
            File.SetAttributes(systemFile, systemFileAttributes);
            File.SetAttributes(hiddenDir, hiddenDirAttributes);
        }
    }

    [Fact]
    public void List_subdirectory_returns_relative_paths_with_forward_slashes()
    {
        var root = TestHelpers.TestDir();
        CreateDirectory(root, "子目录");
        CreateDirectory(root, Path.Combine("子目录", "深层"));
        CreateFile(root, Path.Combine("子目录", "笔记 A.md"));
        CreateFile(root, Path.Combine("子目录", "深层", "leaf.md"));
        CreateFile(root, "root.md");

        var entries = DirectoryLister.List(root, "子目录");

        Assert.Equal(new[] { "深层", "笔记 A.md" }, entries.Select(entry => entry.Name));
        Assert.Equal(
            new[] { "子目录/深层", "子目录/笔记 A.md" },
            entries.Select(entry => entry.RelPath));

        // 反斜杠与正斜杠都接受（前端消息里是相对 root 的路径）
        var nested = DirectoryLister.List(root, @"子目录\深层");
        Assert.Single(nested);
        Assert.Equal("leaf.md", nested[0].Name);
        Assert.Equal("子目录/深层/leaf.md", nested[0].RelPath);
    }

    [Fact]
    public void List_empty_or_blank_relative_path_means_the_browse_root()
    {
        var root = TestHelpers.TestDir();
        CreateFile(root, "a.md");

        var byEmpty = DirectoryLister.List(root, string.Empty);
        var byNull = DirectoryLister.List(root, null!);
        var byBlank = DirectoryLister.List(root, "   ");

        Assert.Equal(new[] { "a.md" }, byEmpty.Select(entry => entry.Name));
        Assert.Equal(byEmpty.Select(entry => entry.Name), byNull.Select(entry => entry.Name));
        Assert.Equal(byEmpty.Select(entry => entry.Name), byBlank.Select(entry => entry.Name));
    }

    [Fact]
    public void List_rejects_paths_outside_the_browse_root()
    {
        var root = TestHelpers.TestDir();
        var parent = Path.GetDirectoryName(root)!;
        var siblingName = Path.GetFileName(root) + "-sibling";
        var sibling = Path.Combine(parent, siblingName);
        Directory.CreateDirectory(sibling);

        try
        {
            Assert.Throws<UnauthorizedAccessException>(() => DirectoryLister.List(root, ".."));
            Assert.Throws<UnauthorizedAccessException>(() => DirectoryLister.List(root, @"..\" + siblingName));
            Assert.Throws<UnauthorizedAccessException>(() => DirectoryLister.List(root, sibling));
        }
        finally
        {
            Directory.Delete(sibling, recursive: true);
        }

        Assert.Throws<ArgumentException>(() => DirectoryLister.List(" ", string.Empty));
    }

    [Fact]
    public void List_missing_subdirectory_throws()
    {
        var root = TestHelpers.TestDir();

        Assert.Throws<DirectoryNotFoundException>(() => DirectoryLister.List(root, "missing"));
    }

    [Fact]
    public void List_rejects_navigation_through_a_reparse_point()
    {
        var root = TestHelpers.TestDir();
        var real = CreateDirectory(root, "real");
        CreateFile(real, "a.md");
        var link = Path.Combine(root, "link");

        try
        {
            Directory.CreateSymbolicLink(link, real);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            // 当前环境不允许创建符号链接（未开启开发者模式等）：重解析点防御由下方代码审查与既有实现兜底
            return;
        }

        var entries = DirectoryLister.List(root, string.Empty);
        Assert.DoesNotContain(entries, entry => entry.Name == "link");
        Assert.Contains(entries, entry => entry.Name == "real");
        Assert.Throws<UnauthorizedAccessException>(() => DirectoryLister.List(root, "link"));
    }

    [Fact]
    public void List_truncates_at_max_entries_after_sorting()
    {
        var root = TestHelpers.TestDir();
        CreateFile(root, "a.md");
        CreateFile(root, "b.md");
        CreateFile(root, "c.md");
        CreateDirectory(root, "dir-a");
        CreateDirectory(root, "dir-b");

        var entries = DirectoryLister.List(root, string.Empty, maxEntries: 3);

        Assert.Equal(3, entries.Count);
        Assert.Equal(new[] { "dir-a", "dir-b", "a.md" }, entries.Select(entry => entry.Name));
        Assert.Empty(DirectoryLister.List(root, string.Empty, maxEntries: 0));
    }
}
