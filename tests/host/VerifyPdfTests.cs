using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// VerifyPdf（Task 15 评审加固）：--verify-pdf 导出前清理旧输出、失败时清理半成品。
/// 删除不存在的文件是空操作（File.Delete 语义），清理失败只记日志、绝不抛异常。
/// </summary>
public class VerifyPdfTests
{
    [Fact]
    public void Export_timeout_leaves_room_for_the_inner_print_timeout()
    {
        // readyToPrint 10 s + PrintToPdf 60 s 的内层等待必须完整容纳；外层只兜 WebView 整体卡死。
        Assert.True(
            VerifyPdf.ExportTimeoutMilliseconds
                >= PdfExport.ReadyTimeoutMilliseconds + PdfExport.PrintTimeoutMilliseconds,
            $"外层超时 {VerifyPdf.ExportTimeoutMilliseconds} ms 必须覆盖内层 "
                + $"{PdfExport.ReadyTimeoutMilliseconds} + {PdfExport.PrintTimeoutMilliseconds} ms");
    }

    [Fact]
    public void TryDeleteOutput_removes_stale_file_and_ignores_missing_path()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jj-verify-pdf-{Guid.NewGuid():N}.pdf");
        File.WriteAllText(path, "stale output from a previous run");

        Assert.True(VerifyPdf.TryDeleteOutput(path));
        Assert.False(File.Exists(path));

        // 再次清理（文件已不存在）仍应成功：导出失败的清理路径可能重复调用。
        Assert.True(VerifyPdf.TryDeleteOutput(path));
    }
}
