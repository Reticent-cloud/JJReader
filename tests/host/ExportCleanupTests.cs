using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// M8：PDF 导出失败时只清理「本次写出来的半成品」，导出前已存在且未被改写的用户原文件必须保留。
/// （UI toast/资源管理器定位无法在单测里构造，列入手测清单。）
/// </summary>
public class ExportCleanupTests
{
    [Fact]
    public void Deletes_partial_file_that_did_not_exist_before_export()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "new.pdf");
        File.WriteAllText(path, "partial");

        MainWindow.DeletePartialPdf(path, existsBefore: false, writeTimeBefore: default);

        Assert.False(File.Exists(path));
    }

    [Fact]
    public void Keeps_preexisting_file_untouched_by_this_export()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "keep.pdf");
        File.WriteAllText(path, "user pdf");
        var before = File.GetLastWriteTimeUtc(path);

        MainWindow.DeletePartialPdf(path, existsBefore: true, writeTimeBefore: before);

        Assert.True(File.Exists(path));
        Assert.Equal("user pdf", File.ReadAllText(path));
    }

    [Fact]
    public void Deletes_preexisting_file_that_this_export_rewrote()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "overwritten.pdf");
        File.WriteAllText(path, "user pdf");
        var staleWriteTime = File.GetLastWriteTimeUtc(path).AddMinutes(-5);

        // 模拟导出失败前已经改写了目标文件：时间戳与导出前不同 → 视为半成品删除。
        MainWindow.DeletePartialPdf(path, existsBefore: true, writeTimeBefore: staleWriteTime);

        Assert.False(File.Exists(path));
    }

    [Fact]
    public void Missing_file_is_a_noop()
    {
        var path = Path.Combine(TestHelpers.TestDir(), "missing.pdf");

        MainWindow.DeletePartialPdf(path, existsBefore: false, writeTimeBefore: default);

        Assert.False(File.Exists(path));
    }
}
