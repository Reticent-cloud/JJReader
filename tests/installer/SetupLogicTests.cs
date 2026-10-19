using JingjingReader.Setup;
using System.IO.Compression;
using Xunit;

namespace JingjingReader.Setup.Tests;

/// <summary>
/// 安装器纯逻辑测试：路径规范化/校验、快捷方式路径、卸载项、payload 条目校验、
/// 命令行参数与有效默认程序判定。不写注册表、不创建 UI。
/// </summary>
public class SetupLogicTests
{
    private const string WindowsDir = @"C:\Windows";
    private const string ProgramFilesDir = @"C:\Program Files";
    private const string ProgramFilesX86Dir = @"C:\Program Files (x86)";
    private const string AppDataDir = @"C:\Users\Tester\AppData\Roaming\JingjingReader";
    private const string LocalDataDir = @"C:\Users\Tester\AppData\Local\JingjingReader";
    private const string BaseDir = @"C:\base";

    private static InstallDirValidation Normalize(string? raw)
        => SetupLogic.NormalizeInstallDir(
            raw,
            BaseDir,
            WindowsDir,
            ProgramFilesDir,
            ProgramFilesX86Dir,
            AppDataDir,
            LocalDataDir);

    [Theory]
    [InlineData(@"C:\Apps\JingjingReader")]
    [InlineData(@"C:\Users\Tester\AppData\Local\Programs\JingjingReader")]
    [InlineData(@"D:\工具\阅读器")]
    [InlineData(@"C:\Apps\My Reader")]
    public void Normalize_AcceptsUserWritableDirectories(string raw)
    {
        var result = Normalize(raw);

        Assert.True(result.IsValid, result.Error);
        Assert.Equal(Path.GetFullPath(raw), result.NormalizedPath);
    }

    [Fact]
    public void Normalize_TrimsQuotesAndWhitespaceAndTrailingSeparator()
    {
        var result = Normalize("  \"C:\\Apps\\JingjingReader\\\"  ");

        Assert.True(result.IsValid, result.Error);
        Assert.Equal(@"C:\Apps\JingjingReader", result.NormalizedPath);
    }

    [Fact]
    public void Normalize_ResolvesRelativePathAgainstBaseDirectory()
    {
        var result = Normalize(@"sub\JingjingReader");

        Assert.True(result.IsValid, result.Error);
        Assert.Equal(@"C:\base\sub\JingjingReader", result.NormalizedPath);
    }

    [Fact]
    public void Normalize_ExpandsEnvironmentVariables()
    {
        const string value = @"C:\Env\JingjingReader";
        Environment.SetEnvironmentVariable("JJ_SETUP_TEST_DIR", value);
        try
        {
            var result = Normalize(@"%JJ_SETUP_TEST_DIR%\nested");

            Assert.True(result.IsValid, result.Error);
            Assert.Equal(@"C:\Env\JingjingReader\nested", result.NormalizedPath);
        }
        finally
        {
            Environment.SetEnvironmentVariable("JJ_SETUP_TEST_DIR", null);
        }
    }

    [Fact]
    public void Normalize_RejectsBlank()
    {
        Assert.False(Normalize(null).IsValid);
        Assert.False(Normalize("").IsValid);
        Assert.False(Normalize("   ").IsValid);
        Assert.False(Normalize("\"\"").IsValid);
    }

    [Fact]
    public void Normalize_RejectsUnresolvedEnvironmentVariable()
    {
        var result = Normalize(@"%JJ_NO_SUCH_VAR_XYZ%\Reader");

        Assert.False(result.IsValid);
        Assert.Contains("环境变量", result.Error);
    }

    [Fact]
    public void Normalize_RejectsDriveRoot()
    {
        var result = Normalize(@"C:\");

        Assert.False(result.IsValid);
        Assert.Contains("根目录", result.Error);
    }

    [Fact]
    public void Normalize_RejectsUncPath()
    {
        var result = Normalize(@"\\server\share\JingjingReader");

        Assert.False(result.IsValid);
        Assert.Contains("网络路径", result.Error);
    }

    [Fact]
    public void Normalize_RejectsWindowsDirectoryAndChildren()
    {
        Assert.False(Normalize(WindowsDir).IsValid);
        Assert.False(Normalize(@"C:\Windows\System32\Reader").IsValid);
        Assert.True(Normalize(@"C:\WindowsApps\Reader").IsValid); // 前缀相似但不是 Windows 子目录
    }

    [Fact]
    public void Normalize_RejectsProgramFiles()
    {
        Assert.False(Normalize(@"C:\Program Files\Reader").IsValid);
        Assert.False(Normalize(@"C:\Program Files (x86)\Reader").IsValid);
    }

    [Fact]
    public void Normalize_RejectsUserDataDirectoriesAndTheirAncestors()
    {
        Assert.False(Normalize(AppDataDir).IsValid);
        Assert.False(Normalize(@"C:\Users\Tester\AppData\Roaming").IsValid);
        Assert.False(Normalize(LocalDataDir).IsValid);
        Assert.False(Normalize(@"C:\Users\Tester\AppData\Local").IsValid);
    }

    [Fact]
    public void Normalize_AllowsChildOfUserDataDirectory()
    {
        var result = Normalize(@"C:\Users\Tester\AppData\Roaming\JingjingReader\app");

        Assert.True(result.IsValid, result.Error);
    }

    [Fact]
    public void Normalize_RejectsInvalidCharacters()
    {
        Assert.False(Normalize(@"C:\Apps\Rea|der").IsValid);
        Assert.False(Normalize(@"C:\Apps\Rea*der").IsValid);
        Assert.False(Normalize(@"C:\Apps\Rea?der").IsValid);
    }

    [Fact]
    public void Normalize_NormalizesDotDotBeforeSystemDirectoryCheck()
    {
        var result = Normalize(@"C:\Apps\..\Windows\Reader");

        Assert.False(result.IsValid);
        Assert.Contains("Windows", result.Error);
    }

    [Fact]
    public void DefaultInstallDir_IsUnderLocalAppDataPrograms()
    {
        var path = SetupLogic.GetDefaultInstallDir(@"C:\Users\Tester\AppData\Local");

        Assert.Equal(@"C:\Users\Tester\AppData\Local\Programs\JingjingReader", path);
    }

    [Fact]
    public void ShortcutPaths_UseProductShortcutName()
    {
        var startMenu = SetupLogic.GetStartMenuShortcutPath(
            @"C:\Users\Tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs");
        var desktop = SetupLogic.GetDesktopShortcutPath(@"C:\Users\Tester\Desktop");

        Assert.Equal(@"C:\Users\Tester\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\鲸鲸阅读器.lnk", startMenu);
        Assert.Equal(@"C:\Users\Tester\Desktop\鲸鲸阅读器.lnk", desktop);
    }

    [Fact]
    public void BuildUninstallString_QuotesUninstallerExecutable()
    {
        var command = SetupLogic.BuildUninstallString(@"C:\Program Files\Jingjing Reader");

        Assert.Equal(
            "\"C:\\Program Files\\Jingjing Reader\\卸载鲸鲸阅读器.exe\"",
            command);
    }

    [Fact]
    public void BuildQuietUninstallString_AppendsSilent()
    {
        var command = SetupLogic.BuildQuietUninstallString(@"C:\Apps\鲸鲸 阅读器");

        Assert.Equal("\"C:\\Apps\\鲸鲸 阅读器\\卸载鲸鲸阅读器.exe\" --silent", command);
    }

    [Fact]
    public void GetUninstallerPath_UsesChineseFileNameInInstallDir()
    {
        Assert.Equal(
            @"C:\Apps\JingjingReader\卸载鲸鲸阅读器.exe",
            SetupLogic.GetUninstallerPath(@"C:\Apps\JingjingReader"));
    }

    [Fact]
    public void BuildUninstallEntryValues_ContainsRequiredValues()
    {
        var values = SetupLogic.BuildUninstallEntryValues(@"C:\Apps\JingjingReader");

        Assert.Equal("鲸鲸阅读器", values["DisplayName"]);
        Assert.Equal("0.1.0", values["DisplayVersion"]);
        Assert.Equal("鲸鲸阅读器", values["Publisher"]);
        Assert.Equal(@"C:\Apps\JingjingReader\JingjingReader.exe", values["DisplayIcon"]);
        Assert.Equal(@"C:\Apps\JingjingReader", values["InstallLocation"]);
        Assert.Equal(
            "\"C:\\Apps\\JingjingReader\\卸载鲸鲸阅读器.exe\"",
            values["UninstallString"]);
        Assert.Equal(
            "\"C:\\Apps\\JingjingReader\\卸载鲸鲸阅读器.exe\" --silent",
            values["QuietUninstallString"]);
    }

    [Fact]
    public void RequiredPayloadFiles_IncludeChineseUninstaller()
    {
        Assert.Contains(SetupLogic.UninstallerFileName, SetupLogic.RequiredPayloadFileNames);
        Assert.Contains("JingjingReader.exe", SetupLogic.RequiredPayloadFileNames);
        Assert.Contains("uninstall.ps1", SetupLogic.RequiredPayloadFileNames);
    }

    [Fact]
    public void PayloadZip_WhenPresent_ContainsChineseUninstaller()
    {
        // payload.zip 是构建产物（git 忽略）；干净源码树上没有时跳过实际 ZIP 检查，
        // 仍由 RequiredPayloadFiles 断言安装器会校验卸载器。构建后（CI/本地冒烟）会真正解包检查。
        var payload = FindPayloadZip();
        if (payload is null)
        {
            return;
        }

        using var archive = ZipFile.OpenRead(payload);
        Assert.Contains(
            archive.Entries,
            entry => entry.FullName.Equals(SetupLogic.UninstallerFileName, StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(@"C:\Apps\Reader", true)]
    [InlineData(@"C:\Apps\Reader\", true)]
    [InlineData(@"C:\Apps\Reader2", false)]
    [InlineData(@"C:\Apps", false)]
    [InlineData(@"C:\apps\reader", true)]
    [InlineData(@"C:\Apps\Reader\sub", true)]
    public void IsSameOrUnder_ComparesPathBoundaries(string path, bool expected)
    {
        Assert.Equal(expected, SetupLogic.IsSameOrUnder(path, @"C:\Apps\Reader"));
    }

    [Theory]
    [InlineData(@"JingjingReader.md", true)]
    [InlineData(@"jingjingreader.MD", true)]
    [InlineData(@"  JingjingReader.md  ", true)]
    [InlineData(@"Other.md", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData(@"JingjingReader.md.backup", false)]
    public void IsJingjingReaderProgId_ComparesCaseInsensitively(string? progId, bool expected)
    {
        Assert.Equal(expected, SetupLogic.IsJingjingReaderProgId(progId));
    }

    [Fact]
    public void ResolveEffectiveProgId_PrefersUserChoiceOverClassesDefault()
    {
        Assert.Equal("Other.md", SetupLogic.ResolveEffectiveProgId("Other.md", "JingjingReader.md"));
        Assert.Equal("JingjingReader.md", SetupLogic.ResolveEffectiveProgId(null, "JingjingReader.md"));
        Assert.Equal("JingjingReader.md", SetupLogic.ResolveEffectiveProgId("  ", "JingjingReader.md"));
        Assert.Null(SetupLogic.ResolveEffectiveProgId(null, null));
        Assert.Null(SetupLogic.ResolveEffectiveProgId("", "  "));
    }

    [Fact]
    public void IsRecognizedInstallDir_OnlyRecognizesExistingExe()
    {
        Assert.True(SetupLogic.IsRecognizedInstallDir(
            @"C:\Apps\Reader",
            path => path == @"C:\Apps\Reader\JingjingReader.exe"));
        Assert.False(SetupLogic.IsRecognizedInstallDir(
            @"C:\Apps\Reader",
            _ => false));
        Assert.False(SetupLogic.IsRecognizedInstallDir("", _ => true));
    }

    [Fact]
    public void PayloadEntry_AcceptsNormalFileAndDirectoryEntries()
    {
        Assert.True(SetupLogic.TryResolvePayloadEntry(
            @"C:\stage", "JingjingReader.exe", out var file, out var error));
        Assert.Null(error);
        Assert.NotNull(file);
        Assert.Equal(@"C:\stage\JingjingReader.exe", file.FullPath);
        Assert.False(file.IsDirectory);

        Assert.True(SetupLogic.TryResolvePayloadEntry(
            @"C:\stage", @"runtimes\win-x64\native\WebView2Loader.dll", out var nested, out error));
        Assert.Null(error);
        Assert.Equal(@"C:\stage\runtimes\win-x64\native\WebView2Loader.dll", nested!.FullPath);

        Assert.True(SetupLogic.TryResolvePayloadEntry(
            @"C:\stage", "runtimes/win-x64/", out var directory, out error));
        Assert.Null(error);
        Assert.True(directory!.IsDirectory);
        Assert.Equal(@"C:\stage\runtimes\win-x64", directory.FullPath);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("../evil.txt")]
    [InlineData("a/../../evil.txt")]
    [InlineData("/evil.txt")]
    [InlineData("//server/share/evil.txt")]
    [InlineData(@"C:\evil.txt")]
    [InlineData("C:/evil.txt")]
    [InlineData("/")]
    [InlineData("a//b.txt")]
    [InlineData("a/./b.txt")]
    [InlineData("CON")]
    [InlineData("a/CON.txt")]
    [InlineData("a/b.")]
    [InlineData("a/b ")]
    [InlineData("a/b:c")]
    [InlineData("a/b|c.txt")]
    public void PayloadEntry_RejectsTraversalAndInvalidNames(string? entryName)
    {
        var ok = SetupLogic.TryResolvePayloadEntry(@"C:\stage", entryName, out var entry, out var error);

        Assert.False(ok);
        Assert.Null(entry);
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Fact]
    public void PayloadEntry_RejectsBlankTargetDirectory()
    {
        Assert.False(SetupLogic.TryResolvePayloadEntry("", "a.txt", out _, out var error));
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Fact]
    public void PayloadEntry_AcceptsChineseFileName()
    {
        Assert.True(SetupLogic.TryResolvePayloadEntry(
            @"C:\stage", "文档/鲸鲸阅读器.md", out var entry, out var error));

        Assert.Null(error);
        Assert.Equal(@"C:\stage\文档\鲸鲸阅读器.md", entry!.FullPath);
    }

    [Fact]
    public void ParseArgs_DefaultsToInteractiveInstall()
    {
        var options = SetupLogic.ParseArgs(Array.Empty<string>(), @"C:\Apps\JingjingReader");

        Assert.False(options.Silent);
        Assert.Equal(@"C:\Apps\JingjingReader", options.InstallDir);
        Assert.True(options.CreateAssociation);
        Assert.True(options.CreateStartMenuShortcut);
        Assert.True(options.CreateDesktopShortcut);
        Assert.True(options.Launch);
        Assert.False(options.ShowHelp);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_ParsesSilentOptions()
    {
        var options = SetupLogic.ParseArgs(
            new[] { "--silent", "--install-dir", @"D:\Apps\Reader", "--no-shortcuts", "--no-launch" },
            @"C:\default");

        Assert.True(options.Silent);
        Assert.Equal(@"D:\Apps\Reader", options.InstallDir);
        Assert.False(options.CreateStartMenuShortcut);
        Assert.False(options.CreateDesktopShortcut);
        Assert.False(options.Launch);
        Assert.True(options.CreateAssociation);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_AcceptsInstallDirEqualsFormAndCaseInsensitiveFlags()
    {
        var options = SetupLogic.ParseArgs(
            new[] { "--SILENT", @"--INSTALL-DIR=C:\Custom", "--NO-LAUNCH" },
            @"C:\default");

        Assert.True(options.Silent);
        Assert.Equal(@"C:\Custom", options.InstallDir);
        Assert.False(options.Launch);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_ReportsMissingInstallDirValue()
    {
        var options = SetupLogic.ParseArgs(new[] { "--install-dir" }, @"C:\default");

        Assert.NotNull(options.Error);
        Assert.Contains("--install-dir", options.Error);
    }

    [Fact]
    public void ParseArgs_ReportsUnknownArgument()
    {
        var options = SetupLogic.ParseArgs(new[] { "--bogus" }, @"C:\default");

        Assert.NotNull(options.Error);
        Assert.Contains("--bogus", options.Error);
    }

    [Fact]
    public void ParseArgs_ParsesHelp()
    {
        var options = SetupLogic.ParseArgs(new[] { "--help" }, @"C:\default");

        Assert.True(options.ShowHelp);
        Assert.Null(options.Error);
    }

    [Fact]
    public void ParseArgs_LastInstallDirWins()
    {
        var options = SetupLogic.ParseArgs(
            new[] { "--install-dir", @"C:\one", "--install-dir", @"C:\two" },
            @"C:\default");

        Assert.Equal(@"C:\two", options.InstallDir);
    }

    [Fact]
    public void RuntimeCheck_DetectsDesktopRuntime10()
    {
        var root = CreateTempDirectory();
        try
        {
            var shared = Path.Combine(root, "shared", "Microsoft.WindowsDesktop.App");
            Directory.CreateDirectory(Path.Combine(shared, "9.0.1"));
            Assert.False(SetupLogic.IsDesktopRuntime10Installed(shared));

            Directory.CreateDirectory(Path.Combine(shared, "10.0.12"));
            Assert.True(SetupLogic.IsDesktopRuntime10Installed(shared));
            Assert.Null(SetupLogic.CheckRuntime(new Version(10, 0, 12), shared));
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void RuntimeCheck_ReportsMissingRuntimeWithDownloadLink()
    {
        var missing = Path.Combine(Path.GetTempPath(), "jj-missing-" + Guid.NewGuid().ToString("N"));
        try
        {
            var message = SetupLogic.CheckRuntime(new Version(10, 0, 12), missing);

            Assert.NotNull(message);
            Assert.Contains(SetupLogic.RuntimeDownloadUrl, message);
        }
        finally
        {
            TryDelete(missing);
        }
    }

    [Fact]
    public void RuntimeCheck_ReportsTooOldRuntime()
    {
        var root = CreateTempDirectory();
        try
        {
            var shared = Path.Combine(root, "shared", "Microsoft.WindowsDesktop.App");
            Directory.CreateDirectory(Path.Combine(shared, "10.0.12"));

            var message = SetupLogic.CheckRuntime(new Version(8, 0, 0), shared);

            Assert.NotNull(message);
            Assert.Contains("10", message);
            Assert.Contains(SetupLogic.RuntimeDownloadUrl, message);
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static string? FindPayloadZip()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "installer",
                "JingjingReaderSetup",
                "payload.zip");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "jj-installer-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception)
        {
            // 测试清理失败不掩盖断言结果。
        }
    }
}
