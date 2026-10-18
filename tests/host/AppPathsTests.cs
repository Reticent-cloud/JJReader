using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 验收隔离（修复波 B-I2）：JJ_DATA_DIR 覆盖数据目录与 WebView2 用户数据目录。
/// 修复波 D：未设置 JJ_DATA_DIR 时，数据目录仍是漫游 <c>%APPDATA%\JingjingReader</c>，
/// 但 WebView2 用户数据目录（UDF）必须是本地 <c>%LOCALAPPDATA%\JingjingReader\WebView2</c>
/// （漫游/域重定向路径可能是 UNC，WebView2 官方明确不建议）。
/// </summary>
public class AppPathsTests
{
    [Fact]
    public void Default_data_dir_is_appdata_jingjingreader()
    {
        var appData = Path.Combine(Path.GetTempPath(), "jj-appdata");

        Assert.Equal(Path.Combine(appData, AppPaths.DataDirectoryName), AppPaths.ResolveDataDir(null, appData));
        Assert.Equal(Path.Combine(appData, AppPaths.DataDirectoryName), AppPaths.ResolveDataDir("   ", appData));
    }

    [Fact]
    public void Override_data_dir_is_used_verbatim_as_absolute_path()
    {
        var appData = Path.Combine(Path.GetTempPath(), "jj-appdata");
        var overrideDir = Path.Combine(Path.GetTempPath(), "jj-isolated-data");

        Assert.Equal(overrideDir, AppPaths.ResolveDataDir(overrideDir, appData));
        Assert.Equal(overrideDir, AppPaths.ResolveDataDir($"  {overrideDir}  ", appData));
    }

    [Fact]
    public void Invalid_override_falls_back_to_default()
    {
        var appData = Path.Combine(Path.GetTempPath(), "jj-appdata");

        // NUL 字符在 .NET 里无法构成合法绝对路径：必须回退默认而不是抛异常
        Assert.Equal(
            Path.Combine(appData, AppPaths.DataDirectoryName),
            AppPaths.ResolveDataDir("bad\0path", appData));
    }

    [Fact]
    public void Default_webview_dir_is_localappdata_jingjingreader_webview2()
    {
        var previous = Environment.GetEnvironmentVariable(AppPaths.DataDirOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, null);

            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            Assert.Equal(
                Path.Combine(localAppData, AppPaths.DataDirectoryName, AppPaths.WebViewDataDirectoryName),
                AppPaths.WebViewDataDir);

            // 数据目录保持漫游 %APPDATA%：本次只修 WebView2 UDF 的默认值。
            Assert.Equal(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    AppPaths.DataDirectoryName),
                AppPaths.DataDir);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, previous);
        }
    }

    [Fact]
    public void Resolve_webview_dir_uses_localappdata_or_valid_override()
    {
        var appData = Path.Combine(Path.GetTempPath(), "jj-appdata");
        var localAppData = Path.Combine(Path.GetTempPath(), "jj-localappdata");
        var overrideDir = Path.Combine(Path.GetTempPath(), "jj-isolated-data");
        var localDefault = Path.Combine(localAppData, AppPaths.DataDirectoryName, AppPaths.WebViewDataDirectoryName);

        Assert.Equal(localDefault, AppPaths.ResolveWebViewDataDir(null, localAppData));
        Assert.Equal(localDefault, AppPaths.ResolveWebViewDataDir("   ", localAppData));
        // 非法覆盖值与 ResolveDataDir 同口径：回退默认（本地 UDF），不能回退到漫游 %APPDATA%。
        Assert.Equal(localDefault, AppPaths.ResolveWebViewDataDir("bad\0path", localAppData));
        Assert.Equal(
            Path.Combine(overrideDir, AppPaths.WebViewDataDirectoryName),
            AppPaths.ResolveWebViewDataDir(overrideDir, localAppData));

        // 数据目录仍按 %APPDATA% 解析（appData 参数未被忽略）。
        Assert.Equal(
            Path.Combine(appData, AppPaths.DataDirectoryName),
            AppPaths.ResolveDataDir(null, appData));
    }

    [Fact]
    public void Environment_variable_controls_data_and_webview_dirs()
    {
        var isolated = Path.Combine(Path.GetTempPath(), "jj-env-" + Guid.NewGuid().ToString("N"));
        var previous = Environment.GetEnvironmentVariable(AppPaths.DataDirOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, isolated);

            Assert.Equal(isolated, AppPaths.DataDir);
            Assert.Equal(Path.Combine(isolated, AppPaths.WebViewDataDirectoryName), AppPaths.WebViewDataDir);
            Assert.Equal(Path.Combine(isolated, AppPaths.DebugLogFileName), AppPaths.DebugLogPath);
            Assert.Equal(Path.Combine(isolated, AppPaths.AssocBackupFileName), AppPaths.AssocBackupPath);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, previous);
        }
    }

    [Fact]
    public void Empty_environment_variable_keeps_production_default()
    {
        var previous = Environment.GetEnvironmentVariable(AppPaths.DataDirOverrideVariable);
        try
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, string.Empty);

            Assert.Equal(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    AppPaths.DataDirectoryName),
                AppPaths.DataDir);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AppPaths.DataDirOverrideVariable, previous);
        }
    }
}
