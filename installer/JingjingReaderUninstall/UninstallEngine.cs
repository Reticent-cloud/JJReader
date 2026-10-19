using System.Diagnostics;
using System.IO;

namespace JingjingReader.Uninstall;

/// <summary>
/// 卸载引擎：校验安装目录 → 把 uninstall.ps1 复制到 <c>%TEMP%\jj-uninstall-&lt;guid&gt;</c> →
/// 以独立进程启动 Windows PowerShell（不等待其结束）→ 立即返回。
/// 安装目录由脚本在卸载器退出后删除；卸载器只负责启动与结果提示。
/// </summary>
internal static class UninstallEngine
{
    /// <summary>启动卸载脚本。任何可预期失败都转成 <see cref="UninstallStartResult"/>，不向 UI 抛异常。</summary>
    internal static UninstallStartResult Start(string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);

        var normalized = UninstallLogic.ResolveInstallDir(installDir, installDir);
        if (!Directory.Exists(normalized))
        {
            return Failure(normalized, $"安装目录不存在：{normalized}");
        }

        var sourceScript = Path.Combine(normalized, UninstallLogic.UninstallScriptFileName);
        if (!File.Exists(sourceScript))
        {
            return Failure(normalized, $"安装目录里缺少卸载脚本：{sourceScript}");
        }

        if (!File.Exists(Path.Combine(normalized, UninstallLogic.ExeFileName)))
        {
            return Failure(normalized, $"安装目录里缺少 {UninstallLogic.ExeFileName}，无法还原 .md 打开方式。");
        }

        var tempDirectory = UninstallLogic.GetTempDirectory(Path.GetTempPath(), Guid.NewGuid());
        var tempScript = UninstallLogic.GetTempScriptPath(tempDirectory);
        var logPath = UninstallLogic.GetLogPath(tempDirectory);

        try
        {
            Directory.CreateDirectory(tempDirectory);
            File.Copy(sourceScript, tempScript, overwrite: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            TryDeleteDirectory(tempDirectory);
            return Failure(normalized, $"无法创建临时卸载目录：{exception.Message}");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = UninstallLogic.PowerShellFileName,
            Arguments = UninstallLogic.BuildScriptArguments(tempScript, normalized),
            // 不把安装目录设为工作目录：卸载器退出后脚本要能删除整个安装目录。
            WorkingDirectory = Path.GetDirectoryName(tempDirectory) ?? Path.GetTempPath(),
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        try
        {
            // 只要启动成功就返回，不等待脚本结束。脚本会等待卸载器退出后再删除安装目录。
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                TryDeleteDirectory(tempDirectory);
                return Failure(normalized, "无法启动 Windows PowerShell。");
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException
                                          or System.ComponentModel.Win32Exception
                                          or IOException)
        {
            TryDeleteDirectory(tempDirectory);
            return Failure(normalized, $"无法启动卸载脚本：{exception.Message}");
        }

        return new UninstallStartResult(
            Started: true,
            InstallDir: normalized,
            TempDirectory: tempDirectory,
            LogPath: logPath,
            ErrorMessage: null);
    }

    private static UninstallStartResult Failure(string installDir, string message)
        => new(
            Started: false,
            InstallDir: installDir,
            TempDirectory: null,
            LogPath: null,
            ErrorMessage: message);

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch (Exception)
        {
            // 临时目录清理失败不改变启动失败的主要错误。
        }
    }
}
