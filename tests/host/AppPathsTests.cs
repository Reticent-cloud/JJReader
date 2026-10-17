using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 验收隔离（修复波 B-I2）：JJ_DATA_DIR 覆盖数据目录与 WebView2 用户数据目录；
/// 未设置时生产默认路径不变（AppPaths.ResolveDataDir 纯函数覆盖解析规则）。
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
