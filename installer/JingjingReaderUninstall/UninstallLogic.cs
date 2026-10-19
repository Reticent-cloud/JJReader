using System.IO;

namespace JingjingReader.Uninstall;

/// <summary>
/// 卸载器的纯逻辑（不碰 WPF、不做 I/O 副作用）：参数解析、安装目录推断/规范化、
/// 临时脚本路径、PowerShell 参数拼接与结果文案。
/// 独立成文件是为了让 <c>tests/installer</c> 直接链接本文件做 xUnit 测试。
/// </summary>
public static class UninstallLogic
{
    /// <summary>产品名（与安装器/宿主一致）。</summary>
    public const string ProductName = "鲸鲸阅读器";

    /// <summary>产品版本（与安装器/宿主一致）。</summary>
    public const string ProductVersion = "0.1.0";

    /// <summary>安装目录里的卸载器文件名（安装器写入的 UninstallString 指向它）。</summary>
    public const string UninstallerFileName = "卸载鲸鲸阅读器.exe";

    /// <summary>安装目录里的卸载脚本文件名。</summary>
    public const string UninstallScriptFileName = "uninstall.ps1";

    /// <summary>安装目录里的主程序文件名（用于确认目标确实是鲸鲸阅读器安装目录）。</summary>
    public const string ExeFileName = "JingjingReader.exe";

    /// <summary>卸载器复制到 %TEMP% 下的目录名前缀。</summary>
    public const string TempDirectoryPrefix = "jj-uninstall-";

    /// <summary>卸载脚本写到临时目录里的日志文件名。</summary>
    public const string LogFileName = "uninstall.log";

    /// <summary>系统 Windows PowerShell（5.1）可执行文件名。</summary>
    public const string PowerShellFileName = "powershell.exe";

    /// <summary>确认窗口正文（设置/最近/阅读位置明确保留）。</summary>
    public const string ConfirmationText =
        "确定卸载鲸鲸阅读器？将移除程序与 .md 打开方式；设置/最近/阅读位置会保留。";

    /// <summary>命令行用法（<c>--help</c> / 参数错误时输出）。</summary>
    public const string UsageText =
        """
        用法：
          卸载鲸鲸阅读器.exe                                   打开图形界面，确认后卸载
          卸载鲸鲸阅读器.exe --silent [选项]                    静默卸载（不弹 UI，退出码 0/非 0）
          卸载鲸鲸阅读器.exe --install-dir <目录>              指定安装目录（默认卸载器自身所在目录）

        静默选项：
          --silent              不显示确认界面；退出码 0 = 已成功启动卸载脚本
          --install-dir <目录>   安装目录（默认卸载器自身所在目录）
          --help                显示本帮助

        卸载脚本会注销 .md 打开方式、删除「设置 → 应用」卸载项与开始菜单/桌面快捷方式，
        并在卸载器退出后删除安装目录；设置/最近/阅读位置会保留。
        """;

    /// <summary>安装目录默认值：卸载器 exe 所在目录。</summary>
    public static string GetDefaultInstallDir(string exePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exePath);
        var full = Path.GetFullPath(exePath);
        var directory = Path.GetDirectoryName(full);
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new ArgumentException("无法从卸载器路径推断安装目录。", nameof(exePath));
        }

        return TrimTrailingSeparators(directory);
    }

    /// <summary>
    /// 解析并规范化安装目录：去空白/成对引号 → 绝对路径 → 去尾分隔符；
    /// 拒绝盘符根/UNC。默认值由调用方传入（通常是卸载器自身目录）。
    /// </summary>
    public static string ResolveInstallDir(string? raw, string defaultInstallDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(defaultInstallDir);

        var text = string.IsNullOrWhiteSpace(raw) ? defaultInstallDir : raw.Trim().Trim('"', '\'').Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new ArgumentException("安装目录为空。", nameof(raw));
        }

        var full = TrimTrailingSeparators(Path.GetFullPath(text));
        if (IsUncPath(full))
        {
            throw new ArgumentException("安装目录不能是网络路径（UNC）。", nameof(raw));
        }

        if (IsDriveRoot(full))
        {
            throw new ArgumentException("安装目录不能是磁盘根目录。", nameof(raw));
        }

        return full;
    }

    /// <summary>解析命令行；未知参数/缺值返回 <see cref="UninstallOptions.Error"/>。</summary>
    public static UninstallOptions ParseArgs(IReadOnlyList<string> args, string defaultInstallDir)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentException.ThrowIfNullOrWhiteSpace(defaultInstallDir);

        var silent = false;
        var installDir = defaultInstallDir;
        var showHelp = false;

        for (var i = 0; i < args.Count; i++)
        {
            var argument = args[i];
            if (string.IsNullOrWhiteSpace(argument))
            {
                continue;
            }

            if (argument.Equals("--silent", StringComparison.OrdinalIgnoreCase))
            {
                silent = true;
                continue;
            }

            if (argument.Equals("--help", StringComparison.OrdinalIgnoreCase)
                || argument.Equals("-h", StringComparison.OrdinalIgnoreCase)
                || argument.Equals("/?", StringComparison.OrdinalIgnoreCase))
            {
                showHelp = true;
                continue;
            }

            if (argument.Equals("--install-dir", StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 >= args.Count || string.IsNullOrWhiteSpace(args[i + 1]))
                {
                    return Fail("--install-dir 缺少目录参数。");
                }

                installDir = args[++i];
                continue;
            }

            const string installDirPrefix = "--install-dir=";
            if (argument.StartsWith(installDirPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var value = argument[installDirPrefix.Length..];
                if (string.IsNullOrWhiteSpace(value))
                {
                    return Fail("--install-dir 缺少目录参数。");
                }

                installDir = value;
                continue;
            }

            return Fail($"无法识别的参数：{argument}");
        }

        return new UninstallOptions(silent, installDir, showHelp, Error: null);

        UninstallOptions Fail(string error)
            => new(silent, installDir, showHelp, error);
    }

    /// <summary>本次卸载使用的临时目录：<c>&lt;tempRoot&gt;\jj-uninstall-&lt;guid&gt;</c>。</summary>
    public static string GetTempDirectory(string tempRoot, Guid id)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tempRoot);
        return Path.Combine(Path.GetFullPath(tempRoot), TempDirectoryPrefix + id.ToString("N"));
    }

    /// <summary>临时目录里的卸载脚本副本路径。</summary>
    public static string GetTempScriptPath(string tempDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tempDirectory);
        return Path.Combine(tempDirectory, UninstallScriptFileName);
    }

    /// <summary>临时目录里的卸载日志路径（由 uninstall.ps1 写入）。</summary>
    public static string GetLogPath(string tempDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tempDirectory);
        return Path.Combine(tempDirectory, LogFileName);
    }

    /// <summary>
    /// powershell.exe 的参数：<c>-NoProfile -ExecutionPolicy Bypass -File "&lt;script&gt;" -InstallDir "&lt;dir&gt;"</c>。
    /// 路径加引号，兼容带空格或中文的安装目录。
    /// </summary>
    public static string BuildScriptArguments(string scriptPath, string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scriptPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        return $"-NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\" -InstallDir \"{installDir}\"";
    }

    /// <summary>成功启动卸载脚本后的提示（脚本会在卸载器退出后删除安装目录）。</summary>
    public static string BuildStartedText(string installDir, string logPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        ArgumentException.ThrowIfNullOrWhiteSpace(logPath);
        return string.Join(
            "\n",
            "卸载已开始：正在移除程序与 .md 打开方式。",
            $"安装目录：{installDir}",
            "关闭本窗口后，卸载脚本会删除安装目录。",
            "设置 / 最近文件 / 阅读位置会保留。",
            $"日志（失败时保留）：{logPath}");
    }

    /// <summary>启动失败时的可读提示。</summary>
    public static string BuildFailureText(string error)
        => $"无法开始卸载：{error}\n\n也可以手动运行安装目录里的 uninstall.ps1，或先关闭占用文件的程序后重试。";

    private static string TrimTrailingSeparators(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return path;
        }

        var trimmed = path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (trimmed.Length == 0)
        {
            return path;
        }

        // "C:" 不是有效目录；补回根分隔符，让 IsDriveRoot 能识别并拒绝。
        if (trimmed.Length == 2 && trimmed[1] == ':')
        {
            return trimmed + Path.DirectorySeparatorChar;
        }

        return trimmed;
    }

    private static bool IsUncPath(string path)
        => path.StartsWith(@"\\", StringComparison.Ordinal)
           || path.StartsWith("//", StringComparison.Ordinal);

    private static bool IsDriveRoot(string path)
    {
        var root = Path.GetPathRoot(path);
        if (string.IsNullOrEmpty(root))
        {
            return false;
        }

        return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Equals(
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>卸载器命令行选项。</summary>
public sealed record UninstallOptions(
    bool Silent,
    string InstallDir,
    bool ShowHelp,
    string? Error);

/// <summary>启动卸载脚本的结果；成功时 <see cref="LogPath"/> 指向脚本将要写入的日志。</summary>
public sealed record UninstallStartResult(
    bool Started,
    string InstallDir,
    string? TempDirectory,
    string? LogPath,
    string? ErrorMessage);
