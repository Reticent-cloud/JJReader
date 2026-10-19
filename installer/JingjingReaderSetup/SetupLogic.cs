using System.IO;

namespace JingjingReader.Setup;

/// <summary>
/// 安装器的纯逻辑（不碰 WPF、不做 I/O 副作用）：安装目录校验/规范化、快捷方式路径、
/// 卸载项键值、payload 解压目标校验、命令行参数、有效默认程序判定。
/// 独立成文件是为了让 <c>tests/installer</c> 直接链接本文件做 xUnit 测试，
/// 不必引用 WPF 安装器项目（也避免测试构建依赖 payload.zip）。
/// </summary>
public static class SetupLogic
{
    /// <summary>产品名（与宿主程序一致）。</summary>
    public const string ProductName = "鲸鲸阅读器";

    /// <summary>安装包写进卸载项的版本号（与宿主 <c>Version</c> 一致）。</summary>
    public const string ProductVersion = "0.1.0";

    /// <summary>卸载项 Publisher。</summary>
    public const string Publisher = "鲸鲸阅读器";

    /// <summary>安装后的主程序文件名。</summary>
    public const string ExeFileName = "JingjingReader.exe";

    /// <summary>安装/卸载脚本文件名（随 payload 一起安装）。</summary>
    public const string InstallScriptFileName = "install.ps1";

    /// <summary>卸载脚本文件名（随 payload 一起安装）。</summary>
    public const string UninstallScriptFileName = "uninstall.ps1";

    /// <summary>安装目录里的中文卸载器文件名（随 payload 一起安装，UninstallString 指向它）。</summary>
    public const string UninstallerFileName = "卸载鲸鲸阅读器.exe";

    /// <summary>分发包中的 README。</summary>
    public const string ReadmeFileName = "README.md";

    /// <summary>
    /// payload 必须包含的文件（按安装后的文件名）。安装器解压后逐项校验，缺任何一项都拒绝安装，
    /// 避免出现「安装成功但设置→应用无法卸载」的半成品。
    /// </summary>
    public static readonly IReadOnlyList<string> RequiredPayloadFileNames = new[]
    {
        ExeFileName,
        InstallScriptFileName,
        UninstallScriptFileName,
        UninstallerFileName,
        ReadmeFileName,
    };

    /// <summary>开始菜单/桌面快捷方式文件名。</summary>
    public const string ShortcutFileName = "鲸鲸阅读器.lnk";

    /// <summary>嵌入的载荷文件名（构建脚本生成）。</summary>
    public const string PayloadFileName = "payload.zip";

    /// <summary>嵌入资源的逻辑名（见 csproj 的 LogicalName）。</summary>
    public const string PayloadResourceName = "JingjingReaderSetup.payload.zip";

    /// <summary>ProgID（Global Constraints：与宿主一致）。</summary>
    public const string ProgId = "JingjingReader.md";

    /// <summary>UserChoice 的 ProgId 值名。</summary>
    public const string UserChoiceProgIdValueName = "ProgId";

    /// <summary>开始菜单 Programs 目录（<c>%APPDATA%</c> 下）。</summary>
    public const string StartMenuProgramsRelativePath = @"Microsoft\Windows\Start Menu\Programs";

    /// <summary>卸载项键（HKCU）。</summary>
    public const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\JingjingReader";

    /// <summary>UserChoice 键（只读判断，绝不写入；哈希保护）。</summary>
    public const string UserChoiceKeyPath =
        @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice";

    /// <summary><c>.md</c> 扩展名键（Classes 回退默认值）。</summary>
    public const string ClassesDotMdKeyPath = @"Software\Classes\.md";

    /// <summary>默认安装目录相对 <c>%LOCALAPPDATA%</c> 的部分。</summary>
    public const string DefaultInstallSubPath = @"Programs\JingjingReader";

    /// <summary>.NET 10 Desktop Runtime 下载页。</summary>
    public const string RuntimeDownloadUrl = "https://dotnet.microsoft.com/download/dotnet/10.0";

    /// <summary>Windows「默认应用」设置页 URI。</summary>
    public const string DefaultAppsSettingsUri = "ms-settings:defaultapps";

    /// <summary>命令行用法（<c>--help</c> / 参数错误时输出）。</summary>
    public const string UsageText =
        """
        用法：
          JingjingReaderSetup.exe                         打开图形界面安装
          JingjingReaderSetup.exe --silent [选项]          静默安装（不弹 UI，退出码 0/非 0）

        静默安装选项：
          --install-dir <目录>   安装目录（默认 %LOCALAPPDATA%\Programs\JingjingReader）
          --no-shortcuts         不创建开始菜单/桌面快捷方式
          --no-launch            安装完成后不自动启动鲸鲸阅读器
          --help                显示本帮助

        静默模式默认会注册 .md 打开方式、创建开始菜单快捷方式并启动程序；
        是否已成为 .md 默认程序需要在 Windows「默认应用」中一次确认。
        """;

    /// <summary>默认安装目录：<c>&lt;localAppData&gt;\Programs\JingjingReader</c>。</summary>
    public static string GetDefaultInstallDir(string localAppData)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(localAppData);
        return Path.Combine(localAppData, "Programs", "JingjingReader");
    }

    /// <summary>开始菜单快捷方式路径。</summary>
    public static string GetStartMenuShortcutPath(string startMenuProgramsRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(startMenuProgramsRoot);
        return Path.Combine(startMenuProgramsRoot, ShortcutFileName);
    }

    /// <summary>桌面快捷方式路径（支持桌面被 OneDrive 重定向：由调用方传实际桌面目录）。</summary>
    public static string GetDesktopShortcutPath(string desktopDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(desktopDirectory);
        return Path.Combine(desktopDirectory, ShortcutFileName);
    }

    /// <summary>安装目录里的主程序路径。</summary>
    public static string GetExePath(string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        return Path.Combine(installDir, ExeFileName);
    }

    /// <summary>安装目录里的卸载脚本路径。</summary>
    public static string GetUninstallScriptPath(string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        return Path.Combine(installDir, UninstallScriptFileName);
    }

    /// <summary>安装目录里的中文卸载器路径。</summary>
    public static string GetUninstallerPath(string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        return Path.Combine(installDir, UninstallerFileName);
    }

    /// <summary>
    /// 卸载命令：<c>"&lt;installDir&gt;\卸载鲸鲸阅读器.exe"</c>。
    /// 卸载器默认把自身所在目录当作安装目录，因此自定义安装目录也能正确卸载。
    /// </summary>
    public static string BuildUninstallString(string installDir)
        => $"\"{GetUninstallerPath(installDir)}\"";

    /// <summary>静默卸载命令：<c>"&lt;installDir&gt;\卸载鲸鲸阅读器.exe" --silent</c>。</summary>
    public static string BuildQuietUninstallString(string installDir)
        => BuildUninstallString(installDir) + " --silent";

    /// <summary>写入 <c>HKCU\...\Uninstall\JingjingReader</c> 的字符串值（顺序稳定，便于阅读）。</summary>
    public static IReadOnlyDictionary<string, string> BuildUninstallEntryValues(string installDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(installDir);
        var exe = GetExePath(installDir);
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["DisplayName"] = ProductName,
            ["DisplayVersion"] = ProductVersion,
            ["Publisher"] = Publisher,
            ["DisplayIcon"] = exe,
            ["InstallLocation"] = installDir,
            ["UninstallString"] = BuildUninstallString(installDir),
            ["QuietUninstallString"] = BuildQuietUninstallString(installDir),
        };
    }

    /// <summary>
    /// 安装目录校验/规范化：去空白与成对引号 → 展开环境变量 → 绝对路径 → 去掉末尾分隔符 →
    /// 拒绝盘符根/UNC/非法字符/Windows 与 Program Files/用户数据目录（含其祖先）。
    /// 纯函数：系统目录可由参数注入，测试无需依赖真实机器布局。
    /// </summary>
    public static InstallDirValidation NormalizeInstallDir(
        string? raw,
        string? baseDirectory = null,
        string? windowsDirectory = null,
        string? programFilesDirectory = null,
        string? programFilesX86Directory = null,
        string? dataDirectory = null,
        string? localDataDirectory = null)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return InstallDirValidation.Fail("请选择安装目录。");
        }

        var text = raw.Trim().Trim('"', '\'').Trim();
        if (text.Length == 0)
        {
            return InstallDirValidation.Fail("请选择安装目录。");
        }

        string expanded;
        try
        {
            expanded = Environment.ExpandEnvironmentVariables(text);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            return InstallDirValidation.Fail($"安装目录无效：{exception.Message}");
        }

        // ExpandEnvironmentVariables 对未知变量原样保留 %NAME%，写入注册表/移动目录前必须报错。
        if (expanded.IndexOf('%') >= 0)
        {
            return InstallDirValidation.Fail($"安装目录包含无法展开的环境变量：{text}");
        }

        string full;
        try
        {
            var baseDir = string.IsNullOrWhiteSpace(baseDirectory)
                ? Environment.CurrentDirectory
                : baseDirectory;
            full = Path.GetFullPath(
                Path.IsPathRooted(expanded) ? expanded : Path.Combine(baseDir, expanded));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return InstallDirValidation.Fail($"安装目录无效：{exception.Message}");
        }

        full = TrimTrailingSeparators(full);
        if (full.Length == 0)
        {
            return InstallDirValidation.Fail("请选择安装目录。");
        }

        if (IsUncPath(full))
        {
            return InstallDirValidation.Fail("不支持网络路径（UNC），请选择本地目录。");
        }

        if (IsDriveRoot(full))
        {
            return InstallDirValidation.Fail("安装目录不能是磁盘根目录，请选择子目录。");
        }

        if (HasInvalidPathChars(full))
        {
            return InstallDirValidation.Fail("安装目录包含非法字符（< > \" | ? * 或控制字符）。");
        }

        var windows = string.IsNullOrWhiteSpace(windowsDirectory)
            ? Environment.GetFolderPath(Environment.SpecialFolder.Windows)
            : windowsDirectory;
        if (!string.IsNullOrWhiteSpace(windows) && IsSameOrUnder(full, windows))
        {
            return InstallDirValidation.Fail("安装目录不能位于 Windows 系统目录。");
        }

        foreach (var programFiles in new[]
                 {
                     string.IsNullOrWhiteSpace(programFilesDirectory)
                         ? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)
                         : programFilesDirectory,
                     string.IsNullOrWhiteSpace(programFilesX86Directory)
                         ? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
                         : programFilesX86Directory,
                 })
        {
            if (!string.IsNullOrWhiteSpace(programFiles) && IsSameOrUnder(full, programFiles))
            {
                return InstallDirValidation.Fail(
                    "安装目录不能位于 Program Files（需要管理员权限），请改用默认的用户目录。");
            }
        }

        // 用户数据/缓存目录不能被选成安装目录（卸载会递归删除安装目录）。
        var data = string.IsNullOrWhiteSpace(dataDirectory)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "JingjingReader")
            : dataDirectory;
        if (!string.IsNullOrWhiteSpace(data) && IsSameOrUnder(data, full))
        {
            return InstallDirValidation.Fail("安装目录不能包含鲸鲸阅读器的用户数据目录（%APPDATA%\\JingjingReader）。");
        }

        var localData = string.IsNullOrWhiteSpace(localDataDirectory)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "JingjingReader")
            : localDataDirectory;
        if (!string.IsNullOrWhiteSpace(localData) && IsSameOrUnder(localData, full))
        {
            return InstallDirValidation.Fail(
                "安装目录不能包含鲸鲸阅读器的本地缓存目录（%LOCALAPPDATA%\\JingjingReader）。");
        }

        return InstallDirValidation.Ok(full);
    }

    /// <summary>目录是否已经是一个鲸鲸阅读器安装目录（只认主程序存在）。</summary>
    public static bool IsRecognizedInstallDir(string directory, Func<string, bool> fileExists)
    {
        ArgumentNullException.ThrowIfNull(fileExists);
        if (string.IsNullOrWhiteSpace(directory))
        {
            return false;
        }

        return fileExists(GetExePath(directory));
    }

    /// <summary>路径 <paramref name="path"/> 是否等于 <paramref name="root"/> 或位于其下（大小写不敏感）。</summary>
    public static bool IsSameOrUnder(string path, string root)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(root))
        {
            return false;
        }

        var trimmedPath = path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var trimmedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (trimmedPath.Equals(trimmedRoot, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return trimmedPath.StartsWith(
                   trimmedRoot + Path.DirectorySeparatorChar,
                   StringComparison.OrdinalIgnoreCase)
               || trimmedPath.StartsWith(
                   trimmedRoot + Path.AltDirectorySeparatorChar,
                   StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>有效默认 ProgID：UserChoice 优先，没有时回退 <c>Software\Classes\.md</c> 默认值。</summary>
    public static string? ResolveEffectiveProgId(string? userChoiceProgId, string? classesDotMdDefault)
    {
        if (!string.IsNullOrWhiteSpace(userChoiceProgId))
        {
            return userChoiceProgId.Trim();
        }

        return string.IsNullOrWhiteSpace(classesDotMdDefault) ? null : classesDotMdDefault.Trim();
    }

    /// <summary>有效默认 ProgID 是否就是本程序（大小写不敏感）。</summary>
    public static bool IsJingjingReaderProgId(string? progId)
        => !string.IsNullOrWhiteSpace(progId)
           && string.Equals(progId.Trim(), ProgId, StringComparison.OrdinalIgnoreCase);

    /// <summary>Desktop Runtime 的 shared 目录：<c>&lt;dotnetRoot&gt;\shared\Microsoft.WindowsDesktop.App</c>。</summary>
    public static string GetDesktopRuntimeSharedDir(string dotnetRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dotnetRoot);
        return Path.Combine(dotnetRoot, "shared", "Microsoft.WindowsDesktop.App");
    }

    /// <summary>
    /// 标准位置是否装有 10.x 的 Microsoft.WindowsDesktop.App（安装目标机与安装器都依赖它）。
    /// 只读目录名；目录不存在/不可读返回 false。
    /// </summary>
    public static bool IsDesktopRuntime10Installed(string desktopRuntimeSharedDirectory)
    {
        if (string.IsNullOrWhiteSpace(desktopRuntimeSharedDirectory))
        {
            return false;
        }

        try
        {
            if (!Directory.Exists(desktopRuntimeSharedDirectory))
            {
                return false;
            }

            foreach (var directory in Directory.GetDirectories(desktopRuntimeSharedDirectory))
            {
                var name = Path.GetFileName(directory);
                if (Version.TryParse(name, out var version) && version.Major >= 10)
                {
                    return true;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }

        return false;
    }

    /// <summary>
    /// 运行时检查：返回 null 表示正常；否则返回给用户看的提示（含下载链接）。
    /// 安装器本身是框架依赖的，运行时缺失时 .NET 宿主也会给出安装提示；这里是应用内二次检查。
    /// </summary>
    public static string? CheckRuntime(Version? runtimeVersion, string desktopRuntimeSharedDirectory)
    {
        if (runtimeVersion is { Major: < 10 })
        {
            return $"当前 .NET 运行时版本为 {runtimeVersion}，需要 .NET 10 Desktop Runtime。"
                   + $"请从 {RuntimeDownloadUrl} 安装后再运行。";
        }

        if (!IsDesktopRuntime10Installed(desktopRuntimeSharedDirectory))
        {
            return "未在标准位置检测到 .NET 10 Desktop Runtime。"
                   + "如果安装后鲸鲸阅读器无法启动，请先安装运行时："
                   + RuntimeDownloadUrl;
        }

        return null;
    }

    /// <summary>
    /// 校验 ZIP 条目名并解析到目标目录下的绝对路径：
    /// 拒绝绝对路径/盘符/UNC、<c>..</c> 越界、空段、非法字符、保留设备名、末尾点/空格。
    /// 防止恶意/损坏 payload 写到安装目录之外。
    /// </summary>
    public static bool TryResolvePayloadEntry(
        string targetDirectory,
        string? entryName,
        out PayloadEntry? entry,
        out string? error)
    {
        entry = null;
        error = null;

        if (string.IsNullOrWhiteSpace(targetDirectory))
        {
            error = "解压目标目录为空。";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entryName))
        {
            error = "ZIP 条目名为空。";
            return false;
        }

        var name = entryName.Replace('\\', '/');
        var isDirectory = name.EndsWith("/", StringComparison.Ordinal);
        name = name.TrimEnd('/');
        if (name.Length == 0)
        {
            error = $"ZIP 条目路径为空：{entryName}";
            return false;
        }

        if (name.StartsWith("/", StringComparison.Ordinal) || name.StartsWith("//", StringComparison.Ordinal))
        {
            error = $"ZIP 条目不能是绝对路径：{entryName}";
            return false;
        }

        if (name.Length >= 2 && char.IsAsciiLetter(name[0]) && name[1] == ':')
        {
            error = $"ZIP 条目不能包含盘符：{entryName}";
            return false;
        }

        var segments = name.Split('/');
        foreach (var segment in segments)
        {
            if (segment.Length == 0)
            {
                error = $"ZIP 条目包含空路径段：{entryName}";
                return false;
            }

            if (segment is "." or "..")
            {
                error = $"ZIP 条目不能包含相对路径段：{entryName}";
                return false;
            }

            if (segment.Contains(':', StringComparison.Ordinal)
                || segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                error = $"ZIP 条目包含非法字符：{entryName}";
                return false;
            }

            if (segment.EndsWith(' ') || segment.EndsWith('.'))
            {
                error = $"ZIP 条目路径段不能以空格或点结尾：{entryName}";
                return false;
            }

            if (IsReservedDeviceName(segment))
            {
                error = $"ZIP 条目使用了 Windows 保留设备名：{entryName}";
                return false;
            }
        }

        string targetFull;
        string combinedFull;
        try
        {
            targetFull = TrimTrailingSeparators(Path.GetFullPath(targetDirectory));
            combinedFull = Path.GetFullPath(Path.Combine(targetFull, Path.Combine(segments)));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            error = $"ZIP 条目路径无效：{entryName}（{exception.Message}）";
            return false;
        }

        var targetPrefix = targetFull.EndsWith(Path.DirectorySeparatorChar)
            ? targetFull
            : targetFull + Path.DirectorySeparatorChar;
        if (!combinedFull.StartsWith(targetPrefix, StringComparison.OrdinalIgnoreCase))
        {
            error = $"ZIP 条目会写到目标目录之外：{entryName}";
            return false;
        }

        entry = new PayloadEntry(combinedFull, isDirectory);
        return true;
    }

    /// <summary>
    /// 解析命令行。UI 模式只用 <c>--install-dir</c> 预填，其余选项用于静默安装。
    /// 未知参数返回 <see cref="SetupOptions.Error"/>，由调用方决定是否显示。
    /// </summary>
    public static SetupOptions ParseArgs(IReadOnlyList<string> args, string defaultInstallDir)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentException.ThrowIfNullOrWhiteSpace(defaultInstallDir);

        var silent = false;
        var installDir = defaultInstallDir;
        var createAssociation = true;
        var createStartMenuShortcut = true;
        var createDesktopShortcut = true;
        var launch = true;
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

            if (argument.Equals("--no-shortcuts", StringComparison.OrdinalIgnoreCase))
            {
                createStartMenuShortcut = false;
                createDesktopShortcut = false;
                continue;
            }

            if (argument.Equals("--no-launch", StringComparison.OrdinalIgnoreCase))
            {
                launch = false;
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

        return new SetupOptions(
            silent,
            installDir,
            createAssociation,
            createStartMenuShortcut,
            createDesktopShortcut,
            launch,
            showHelp,
            Error: null);

        SetupOptions Fail(string error)
            => new(silent, installDir, createAssociation, createStartMenuShortcut, createDesktopShortcut,
                launch, showHelp, error);
    }

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

    private static bool HasInvalidPathChars(string path)
    {
        foreach (var character in path)
        {
            if (character < ' ' || character is '<' or '>' or '"' or '|' or '?' or '*')
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsReservedDeviceName(string segment)
    {
        var name = segment;
        var dot = name.IndexOf('.');
        if (dot >= 0)
        {
            name = name[..dot];
        }

        name = name.TrimEnd(' ');
        if (name.Length == 0)
        {
            return false;
        }

        if (name.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || name.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || name.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || name.Equals("NUL", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (name.Length == 4
            && (name.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("LPT", StringComparison.OrdinalIgnoreCase))
            && name[3] is >= '1' and <= '9')
        {
            return true;
        }

        return false;
    }
}

/// <summary>安装目录校验结果；失败时 <see cref="NormalizedPath"/> 为空串。</summary>
public sealed record InstallDirValidation(bool IsValid, string NormalizedPath, string? Error)
{
    /// <summary>校验通过。</summary>
    public static InstallDirValidation Ok(string path) => new(true, path, null);

    /// <summary>校验失败。</summary>
    public static InstallDirValidation Fail(string error) => new(false, string.Empty, error);
}

/// <summary>ZIP 条目解析结果（<see cref="FullPath"/> 已限制在解压目标目录内）。</summary>
public sealed record PayloadEntry(string FullPath, bool IsDirectory);

/// <summary>安装器命令行选项（静默模式）。</summary>
public sealed record SetupOptions(
    bool Silent,
    string InstallDir,
    bool CreateAssociation,
    bool CreateStartMenuShortcut,
    bool CreateDesktopShortcut,
    bool Launch,
    bool ShowHelp,
    string? Error);
