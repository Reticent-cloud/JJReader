using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 13 openFile 解析：绝对路径由调用方直接打开（本解析器只处理文档目录内的相对目标），
/// 相对目标 ①精确路径 ②无扩展名补 .md ③委托 <see cref="NoteResolver"/> 递归寻文件；越界/缺失返回 null。
/// </summary>
public class OpenTargetResolverTests
{
    private static string Normalized(params string[] parts) => FileHost.NormalizePath(Path.Combine(parts));

    [Fact]
    public void Resolve_opens_exact_relative_file()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "a.md"), "# x");
        File.WriteAllText(Path.Combine(dir, "Mixed.MD"), "# x");

        Assert.Equal(Normalized(dir, "a.md"), OpenTargetResolver.Resolve(dir, "a.md"));
        Assert.Equal(Normalized(dir, "a.md"), OpenTargetResolver.Resolve(dir, @".\a.md"));
        // 大小写不同也命中，并返回磁盘上的真实大小写（避免最近记录出现两条仅大小写不同的路径）
        Assert.Equal(Normalized(dir, "Mixed.MD"), OpenTargetResolver.Resolve(dir, "mixed.md"));
    }

    [Fact]
    public void Resolve_completes_md_extension()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "a.md"), "# x");

        Assert.Equal(Normalized(dir, "a.md"), OpenTargetResolver.Resolve(dir, "a"));
        Assert.Equal(Normalized(dir, "a.md"), OpenTargetResolver.Resolve(dir, ".\\a"));
    }

    [Fact]
    public void Resolve_falls_back_to_note_search()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "子目录"));
        File.WriteAllText(Path.Combine(dir, "子目录", "Note.md"), "# x");
        File.WriteAllText(Path.Combine(dir, "Readme.MD"), "# x");

        // 子目录 + 大小写不敏感 + 无扩展名：前两步都不命中，交给 NoteResolver
        Assert.Equal(Normalized(dir, "子目录", "Note.md"), OpenTargetResolver.Resolve(dir, "note"));
        Assert.Equal(Normalized(dir, "Readme.MD"), OpenTargetResolver.Resolve(dir, "readme"));
    }

    [Fact]
    public void Resolve_absolute_path_inside_doc_dir_is_supported()
    {
        var dir = TestHelpers.TestDir();
        var file = Path.Combine(dir, "sub", "a.md");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "# x");

        Assert.Equal(Normalized(file), OpenTargetResolver.Resolve(dir, Normalized(file)));
    }

    [Fact]
    public void Resolve_rejects_traversal_and_missing()
    {
        var dir = TestHelpers.TestDir();
        File.WriteAllText(Path.Combine(dir, "a.md"), "# x");

        Assert.Null(OpenTargetResolver.Resolve(dir, @"..\..\windows\win.ini"));
        Assert.Null(OpenTargetResolver.Resolve(dir, @"..\secret\a.md"));
        Assert.Null(OpenTargetResolver.Resolve(dir, @"\a.md"));
        Assert.Null(OpenTargetResolver.Resolve(dir, "不存在"));
        Assert.Null(OpenTargetResolver.Resolve(dir, ""));
        Assert.Null(OpenTargetResolver.Resolve(dir, "   "));
        Assert.Null(OpenTargetResolver.Resolve("", "a.md"));
    }

    [Fact]
    public void Resolve_rejects_absolute_path_outside_doc_dir()
    {
        var dir = TestHelpers.TestDir();
        var outside = Path.Combine(TestHelpers.TestDir(), "x.md");
        File.WriteAllText(outside, "# x");

        Assert.Null(OpenTargetResolver.Resolve(dir, outside));
    }

    [Fact]
    public void Resolve_does_not_open_directories()
    {
        var dir = TestHelpers.TestDir();
        Directory.CreateDirectory(Path.Combine(dir, "子目录"));

        Assert.Null(OpenTargetResolver.Resolve(dir, "子目录"));
    }
}
