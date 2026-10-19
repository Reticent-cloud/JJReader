using JingjingReader.Uninstall;
using Xunit;

namespace JingjingReader.Setup.Tests;

/// <summary>
/// 卸载器纯逻辑测试：参数解析、安装目录推断/规范化、临时目录与脚本路径、
/// PowerShell 参数拼接、结果/确认文案。不启动进程、不写注册表。
/// </summary>
public class UninstallLogicTests
{
    private const string DefaultDir = @"C:\Users\Tester\AppData\Local\Programs\JingjingReader";

    [Fact]
    public void ConfirmationText_MentionsRemovedAndRetainedData()
    {
        Assert.Contains("确定卸载鲸鲸阅读器", UninstallLogic.ConfirmationText);
        Assert.Contains(".md", UninstallLogic.ConfirmationText);
        Assert.Contains("设置", UninstallLogic.ConfirmationText);
        Assert.Contains("最近", UninstallLogic.ConfirmationText);
        Assert.Contains("阅读位置", UninstallLogic.ConfirmationText);
        Assert.Contains("保留", UninstallLogic.ConfirmationText);
    }

    [Fact]
    public void ParseArgs_DefaultsToInteractiveUninstallInSelfDirectory()
    {
        var options = UninstallLogic.ParseArgs(Array.Empty<string>(), DefaultDir);

        Assert.False(options.Silent);
        Assert.Equal(DefaultDir, options.InstallDir);
        Assert.False(options.ShowHelp);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_ParsesSilentAndInstallDir()
    {
        var options = UninstallLogic.ParseArgs(
            new[] { "--silent", "--install-dir", @"D:\Apps\鲸鲸 Reader" },
            DefaultDir);

        Assert.True(options.Silent);
        Assert.Equal(@"D:\Apps\鲸鲸 Reader", options.InstallDir);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_AcceptsInstallDirEqualsFormAndCaseInsensitiveFlags()
    {
        var options = UninstallLogic.ParseArgs(
            new[] { "--SILENT", @"--INSTALL-DIR=D:\Custom" },
            DefaultDir);

        Assert.True(options.Silent);
        Assert.Equal(@"D:\Custom", options.InstallDir);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_ReportsMissingInstallDirValue()
    {
        var options = UninstallLogic.ParseArgs(new[] { "--install-dir" }, DefaultDir);

        Assert.NotNull(options.Error);
        Assert.Contains("--install-dir", options.Error);
    }

    [Fact]
    public void ParseArgs_ReportsEmptyInstallDirEqualsForm()
    {
        var options = UninstallLogic.ParseArgs(new[] { "--install-dir=" }, DefaultDir);

        Assert.NotNull(options.Error);
        Assert.Contains("--install-dir", options.Error);
    }

    [Fact]
    public void ParseArgs_ReportsUnknownArgument()
    {
        var options = UninstallLogic.ParseArgs(new[] { "--bogus" }, DefaultDir);

        Assert.NotNull(options.Error);
        Assert.Contains("--bogus", options.Error);
    }

    [Fact]
    public void ParseArgs_ParsesHelp()
    {
        var options = UninstallLogic.ParseArgs(new[] { "--help" }, DefaultDir);

        Assert.True(options.ShowHelp);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_LastInstallDirWins()
    {
        var options = UninstallLogic.ParseArgs(
            new[] { "--install-dir", @"C:\one", "--install-dir", @"C:\two" },
            DefaultDir);

        Assert.Equal(@"C:\two", options.InstallDir);
    }

    [Fact]
    public void GetDefaultInstallDir_UsesDirectoryOfUninstallerExecutable()
    {
        var result = UninstallLogic.GetDefaultInstallDir(
            @"D:\工具\鲸鲸阅读器\卸载鲸鲸阅读器.exe");

        Assert.Equal(@"D:\工具\鲸鲸阅读器", result);
    }

    [Fact]
    public void GetDefaultInstallDir_RejectsBlankPath()
    {
        Assert.Throws<ArgumentException>(() => UninstallLogic.GetDefaultInstallDir(""));
        Assert.Throws<ArgumentException>(() => UninstallLogic.GetDefaultInstallDir("   "));
    }

    [Fact]
    public void ResolveInstallDir_TrimsQuotesAndTrailingSeparator()
    {
        var result = UninstallLogic.ResolveInstallDir(
            "  \"D:\\Apps\\JingjingReader\\\"  ",
            DefaultDir);

        Assert.Equal(@"D:\Apps\JingjingReader", result);
    }

    [Fact]
    public void ResolveInstallDir_UsesDefaultWhenBlank()
    {
        Assert.Equal(DefaultDir, UninstallLogic.ResolveInstallDir(null, DefaultDir));
        Assert.Equal(DefaultDir, UninstallLogic.ResolveInstallDir("   ", DefaultDir));
    }

    [Fact]
    public void ResolveInstallDir_RejectsDriveRootAndUnc()
    {
        Assert.Throws<ArgumentException>(() => UninstallLogic.ResolveInstallDir(@"C:\", DefaultDir));
        Assert.Throws<ArgumentException>(
            () => UninstallLogic.ResolveInstallDir(@"\\server\share\JingjingReader", DefaultDir));
    }

    [Fact]
    public void TempPaths_UseJjUninstallPrefixAndGuid()
    {
        var id = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
        var tempDirectory = UninstallLogic.GetTempDirectory(@"C:\Users\Tester\AppData\Local\Temp", id);

        Assert.Equal(
            @"C:\Users\Tester\AppData\Local\Temp\jj-uninstall-00112233445566778899aabbccddeeff",
            tempDirectory);
        Assert.Equal(
            tempDirectory + @"\uninstall.ps1",
            UninstallLogic.GetTempScriptPath(tempDirectory));
        Assert.Equal(
            tempDirectory + @"\uninstall.log",
            UninstallLogic.GetLogPath(tempDirectory));
    }

    [Fact]
    public void BuildScriptArguments_QuotesScriptAndInstallDir()
    {
        var arguments = UninstallLogic.BuildScriptArguments(
            @"C:\Users\Tester\AppData\Local\Temp\jj-uninstall-abc\uninstall.ps1",
            @"D:\工具\鲸鲸 阅读器");

        Assert.Equal(
            "-NoProfile -ExecutionPolicy Bypass -File "
            + "\"C:\\Users\\Tester\\AppData\\Local\\Temp\\jj-uninstall-abc\\uninstall.ps1\" "
            + "-InstallDir \"D:\\工具\\鲸鲸 阅读器\"",
            arguments);
    }

    [Fact]
    public void BuildStartedText_ShowsDirectoryLogAndRetainedData()
    {
        var text = UninstallLogic.BuildStartedText(
            @"C:\Apps\鲸鲸阅读器",
            @"C:\Temp\jj-uninstall-abc\uninstall.log");

        Assert.Contains("卸载已开始", text);
        Assert.Contains(@"C:\Apps\鲸鲸阅读器", text);
        Assert.Contains(@"C:\Temp\jj-uninstall-abc\uninstall.log", text);
        Assert.Contains("关闭本窗口", text);
        Assert.Contains("保留", text);
    }

    [Fact]
    public void BuildFailureText_IncludesReasonAndManualFallback()
    {
        var text = UninstallLogic.BuildFailureText("未找到卸载脚本");

        Assert.Contains("未找到卸载脚本", text);
        Assert.Contains("uninstall.ps1", text);
        Assert.Contains("重试", text);
    }
}
