using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace JingjingReader.Setup;

/// <summary>安装阶段（用于 UI 进度文案）。</summary>
internal enum SetupStage
{
    Preparing,
    Extracting,
    RegisteringAssociation,
    CreatingShortcuts,
    WritingUninstallEntry,
    CheckingDefault,
    Launching,
    Completed,
}

/// <summary>一条安装进度。</summary>
internal sealed record SetupProgress(SetupStage Stage, string Message);

/// <summary>
/// 安装结果。<see cref="Success"/> 为 false 时 <see cref="ErrorMessage"/> 非空；
/// 关联失败/快捷方式失败不会回滚已解压的程序文件（会写卸载项，保证可卸载），但会返回失败。
/// </summary>
internal sealed record SetupResult(
    bool Success,
    string InstallDir,
    string ExePath,
    bool AssociationRequested,
    bool AssociationSucceeded,
    int? AssociationExitCode,
    string? AssociationOutput,
    bool IsDefaultProgram,
    bool NeedsDefaultAppConfirmation,
    bool StartMenuShortcutCreated,
    bool DesktopShortcutCreated,
    bool UninstallEntryWritten,
    bool Launched,
    string? ErrorMessage,
    IReadOnlyList<string> Warnings);

/// <summary>可预期的安装错误（消息直接展示给用户，不附带堆栈）。</summary>
internal sealed class SetupException : Exception
{
    public SetupException(string message)
        : base(message)
    {
    }

    public SetupException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// 安装引擎：解压内嵌 payload → 覆盖安装目录（先写同级临时目录再目录切换）→
/// <c>JingjingReader.exe --install</c> → 快捷方式 → HKCU 卸载项 → 检查有效默认程序。
/// 幂等：重复运行会先备份旧安装目录再整体替换，然后重写快捷方式与卸载项。
/// </summary>
internal static class SetupEngine
{
    private const int AssociationTimeoutMs = 120_000;

    /// <summary>
    /// 安装目录校验（UI 预检 + 安装开始前复检）：语法/系统目录 + 现有目录内容。
    /// 已存在且非空、但不是鲸鲸阅读器安装目录时拒绝，避免覆盖用户自己的文件。
    /// </summary>
    internal static InstallDirValidation ValidateInstallDir(string? raw)
    {
        var normalized = SetupLogic.NormalizeInstallDir(raw, Environment.CurrentDirectory);
        if (!normalized.IsValid)
        {
            return normalized;
        }

        var directory = normalized.NormalizedPath;
        try
        {
            if (File.Exists(directory))
            {
                return InstallDirValidation.Fail("安装目录路径已存在同名文件，请选择其它目录。");
            }

            if (Directory.Exists(directory)
                && Directory.EnumerateFileSystemEntries(directory).Any()
                && !SetupLogic.IsRecognizedInstallDir(directory, File.Exists))
            {
                return InstallDirValidation.Fail(
                    "安装目录已存在且不是鲸鲸阅读器安装目录（缺少 "
                    + SetupLogic.ExeFileName
                    + "）。请选择空目录或已有安装目录。");
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return InstallDirValidation.Fail(Describe(exception));
        }

        return normalized;
    }

    /// <summary>执行安装。任何可预期失败都转成 <see cref="SetupResult"/>，不向 UI/静默入口抛异常。</summary>
    internal static SetupResult Run(SetupOptions options, IProgress<SetupProgress>? progress = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        var warnings = new List<string>();
        var errors = new List<string>();

        var validation = ValidateInstallDir(options.InstallDir);
        if (!validation.IsValid)
        {
            return Failure(string.Empty, validation.Error ?? "安装目录无效。", warnings);
        }

        var installDir = validation.NormalizedPath;
        var exePath = SetupLogic.GetExePath(installDir);

        progress?.Report(new SetupProgress(SetupStage.Preparing, "正在准备安装…"));

        // 1. 解压到安装目录的同级临时目录，再整体切换（失败尽量不留半成品）。
        try
        {
            EnsureInstalledCopyNotRunning(installDir);
            ExtractPayload(installDir, progress);
        }
        catch (Exception exception)
        {
            return Failure(installDir, Describe(exception), warnings);
        }

        var associationSucceeded = false;
        int? associationExitCode = null;
        string? associationOutput = null;

        // 2. 注册 .md 打开方式（HKCU，只影响当前用户）。
        if (options.CreateAssociation)
        {
            progress?.Report(new SetupProgress(SetupStage.RegisteringAssociation, "正在注册 .md 打开方式…"));
            try
            {
                var process = RunProcess(exePath, "--install", installDir, AssociationTimeoutMs);
                associationExitCode = process.ExitCode;
                associationOutput = process.Output;
                associationSucceeded = process.ExitCode == 0;
                if (!associationSucceeded)
                {
                    errors.Add(
                        $"注册 .md 打开方式失败（退出码 {process.ExitCode}）。"
                        + (string.IsNullOrWhiteSpace(process.Output) ? string.Empty : $"\n{process.Output}"));
                }
            }
            catch (Exception exception)
            {
                errors.Add($"注册 .md 打开方式失败：{Describe(exception)}");
            }
        }

        // 3. 开始菜单快捷方式（总是创建）+ 桌面快捷方式（可选）。
        var startMenuShortcutCreated = false;
        var desktopShortcutCreated = false;
        if (options.CreateStartMenuShortcut)
        {
            progress?.Report(new SetupProgress(SetupStage.CreatingShortcuts, "正在创建开始菜单快捷方式…"));
            try
            {
                var path = SetupLogic.GetStartMenuShortcutPath(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs));
                CreateShortcut(path, exePath, installDir);
                startMenuShortcutCreated = true;
            }
            catch (Exception exception)
            {
                errors.Add($"创建开始菜单快捷方式失败：{Describe(exception)}");
            }
        }

        if (options.CreateDesktopShortcut)
        {
            progress?.Report(new SetupProgress(SetupStage.CreatingShortcuts, "正在创建桌面快捷方式…"));
            try
            {
                var path = SetupLogic.GetDesktopShortcutPath(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
                CreateShortcut(path, exePath, installDir);
                desktopShortcutCreated = true;
            }
            catch (Exception exception)
            {
                errors.Add($"创建桌面快捷方式失败：{Describe(exception)}");
            }
        }

        // 4. 卸载项：让「设置 → 应用」里能卸载（卸载脚本会删除该键）。
        var uninstallEntryWritten = false;
        progress?.Report(new SetupProgress(SetupStage.WritingUninstallEntry, "正在写入卸载信息…"));
        try
        {
            WriteUninstallEntry(installDir);
            uninstallEntryWritten = true;
        }
        catch (Exception exception)
        {
            errors.Add($"写入卸载信息失败：{Describe(exception)}");
        }

        // 5. 检查有效默认程序：UserChoice 优先、Classes 回退。
        var isDefault = false;
        var needsDefaultAppConfirmation = false;
        if (options.CreateAssociation)
        {
            progress?.Report(new SetupProgress(SetupStage.CheckingDefault, "正在检查 .md 默认程序…"));
            try
            {
                var effective = SetupLogic.ResolveEffectiveProgId(
                    ReadRegistryString(SetupLogic.UserChoiceKeyPath, SetupLogic.UserChoiceProgIdValueName),
                    ReadRegistryString(SetupLogic.ClassesDotMdKeyPath, valueName: null));
                isDefault = SetupLogic.IsJingjingReaderProgId(effective);
                if (!isDefault)
                {
                    needsDefaultAppConfirmation = true;
                    warnings.Add(
                        "Windows 当前仍把 .md 的默认程序指向其它程序。安装已把鲸鲸阅读器加入「打开方式」；"
                        + "请在「默认应用」中为 .md 选择鲸鲸阅读器一次（之后永久生效）。");
                }
            }
            catch (Exception exception)
            {
                warnings.Add($"检查 .md 默认程序状态失败：{Describe(exception)}");
            }
        }

        // 6. 静默模式默认启动程序（UI 模式只提供按钮，不自动启动）。
        var launched = false;
        if (options.Launch)
        {
            progress?.Report(new SetupProgress(SetupStage.Launching, "正在启动鲸鲸阅读器…"));
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exePath,
                    WorkingDirectory = installDir,
                    UseShellExecute = true,
                });
                launched = true;
            }
            catch (Exception exception)
            {
                warnings.Add($"已安装，但自动启动鲸鲸阅读器失败：{Describe(exception)}");
            }
        }

        var success = errors.Count == 0;
        progress?.Report(new SetupProgress(
            SetupStage.Completed,
            success ? "安装完成。" : "安装完成，但有步骤失败。"));

        return new SetupResult(
            success,
            installDir,
            exePath,
            options.CreateAssociation,
            associationSucceeded,
            associationExitCode,
            associationOutput,
            isDefault,
            needsDefaultAppConfirmation,
            startMenuShortcutCreated,
            desktopShortcutCreated,
            uninstallEntryWritten,
            launched,
            errors.Count == 0 ? null : string.Join("\n", errors),
            warnings);
    }

    /// <summary>覆盖安装前检查主程序是否正在运行：exe 被独占锁住时给出明确提示。</summary>
    private static void EnsureInstalledCopyNotRunning(string installDir)
    {
        var exe = SetupLogic.GetExePath(installDir);
        if (!File.Exists(exe))
        {
            return;
        }

        try
        {
            using var stream = new FileStream(exe, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException exception)
        {
            throw new SetupException(
                "安装目录中的鲸鲸阅读器正在运行。请先关闭鲸鲸阅读器，再重新安装。",
                exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new SetupException(
                "没有权限写入安装目录（程序可能正在运行，或目录受保护）。请关闭程序后重试，或选择其它目录。",
                exception);
        }
    }

    /// <summary>
    /// 解压 payload：先写 <c>&lt;installDir&gt;.staging-&lt;guid&gt;</c>，校验必需文件后用目录切换
    /// 覆盖安装目录；旧目录备份为 <c>&lt;installDir&gt;.old-&lt;guid&gt;</c>，成功后删除、失败则恢复。
    /// </summary>
    private static void ExtractPayload(string installDir, IProgress<SetupProgress>? progress)
    {
        progress?.Report(new SetupProgress(SetupStage.Extracting, "正在解压程序文件…"));

        using var payload = Assembly.GetExecutingAssembly()
                                .GetManifestResourceStream(SetupLogic.PayloadResourceName)
                            ?? throw new SetupException(
                                $"安装包缺少内嵌载荷 {SetupLogic.PayloadResourceName}；请重新构建安装包。");

        var parent = Path.GetDirectoryName(installDir);
        if (string.IsNullOrEmpty(parent))
        {
            throw new SetupException("无法确定安装目录的父目录。");
        }

        Directory.CreateDirectory(parent);

        var leaf = Path.GetFileName(installDir);
        var stage = Path.Combine(parent, leaf + ".staging-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(parent, leaf + ".old-" + Guid.NewGuid().ToString("N"));
        var stageCreated = false;
        var oldMoved = false;
        var installed = false;

        try
        {
            try
            {
                Directory.CreateDirectory(stage);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new SetupException(
                    $"无法创建临时目录 {stage}：{exception.Message}",
                    exception);
            }

            stageCreated = true;

            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (var archiveEntry in archive.Entries)
                {
                    if (!SetupLogic.TryResolvePayloadEntry(
                            stage,
                            archiveEntry.FullName,
                            out var entry,
                            out var error)
                        || entry is null)
                    {
                        throw new SetupException($"安装包内容无效：{error}");
                    }

                    if (entry.IsDirectory)
                    {
                        Directory.CreateDirectory(entry.FullPath);
                        continue;
                    }

                    var directory = Path.GetDirectoryName(entry.FullPath);
                    if (!string.IsNullOrEmpty(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }

                    try
                    {
                        using var input = archiveEntry.Open();
                        using var output = new FileStream(
                            entry.FullPath,
                            FileMode.Create,
                            FileAccess.Write,
                            FileShare.None);
                        input.CopyTo(output);
                    }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                    {
                        throw new SetupException(
                            $"无法写入安装文件 {entry.FullPath}：{exception.Message}",
                            exception);
                    }
                }
            }

            foreach (var required in SetupLogic.RequiredPayloadFileNames)
            {
                if (!File.Exists(Path.Combine(stage, required)))
                {
                    throw new SetupException($"安装包不完整：payload 缺少 {required}。");
                }
            }

            if (Directory.Exists(installDir))
            {
                try
                {
                    Directory.Move(installDir, backup);
                    oldMoved = true;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    throw new SetupException(
                        "无法更新安装目录（文件被占用或没有权限）。请先关闭鲸鲸阅读器后再试。",
                        exception);
                }
            }

            try
            {
                Directory.Move(stage, installDir);
                installed = true;
                stageCreated = false;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                if (oldMoved)
                {
                    try
                    {
                        Directory.Move(backup, installDir);
                        oldMoved = false;
                    }
                    catch (Exception restoreException)
                    {
                        throw new SetupException(
                            $"写入安装目录失败，且旧版本恢复失败。旧版本备份在：{backup}；"
                            + Describe(exception),
                            restoreException);
                    }
                }

                throw new SetupException(
                    "无法写入安装目录（文件被占用或没有权限）。请先关闭鲸鲸阅读器后再试。",
                    exception);
            }

            if (oldMoved)
            {
                try
                {
                    Directory.Delete(backup, recursive: true);
                    oldMoved = false;
                }
                catch (Exception)
                {
                    // 备份目录删不掉不影响本次安装；保留它比删掉正在使用的文件安全。
                }
            }
        }
        finally
        {
            if (stageCreated && Directory.Exists(stage))
            {
                try
                {
                    Directory.Delete(stage, recursive: true);
                }
                catch (Exception)
                {
                    // 临时目录清理失败不掩盖真正的安装结果。
                }
            }

            // installed=false 且 oldMoved=true 表示旧目录还没恢复（例如恢复失败）：
            // 此时必须保留备份，供用户手工找回旧版本。
            if (installed && oldMoved && Directory.Exists(backup))
            {
                try
                {
                    Directory.Delete(backup, recursive: true);
                }
                catch (Exception)
                {
                    // best effort
                }
            }
        }
    }

    /// <summary>创建一条 .lnk（WScript.Shell COM；在独立 STA 线程上调用，避免 UI/线程池公寓问题）。</summary>
    private static void CreateShortcut(string shortcutPath, string exePath, string installDir)
    {
        var directory = Path.GetDirectoryName(shortcutPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        Shortcut.Create(
            shortcutPath,
            exePath,
            installDir,
            $"{SetupLogic.ProductName} Markdown 阅读器",
            exePath);
    }

    /// <summary>写 HKCU 卸载项（字符串值 + NoModify/NoRepair/EstimatedSize）。</summary>
    private static void WriteUninstallEntry(string installDir)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SetupLogic.UninstallKeyPath, writable: true)
                        ?? throw new SetupException($"无法创建注册表键：{SetupLogic.UninstallKeyPath}");

        foreach (var pair in SetupLogic.BuildUninstallEntryValues(installDir))
        {
            key.SetValue(pair.Key, pair.Value, RegistryValueKind.String);
        }

        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        var estimatedKb = EstimateSizeKb(installDir);
        if (estimatedKb > 0)
        {
            key.SetValue("EstimatedSize", estimatedKb, RegistryValueKind.DWord);
        }
    }

    private static int EstimateSizeKb(string directory)
    {
        try
        {
            long bytes = 0;
            foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            {
                try
                {
                    bytes += new FileInfo(file).Length;
                }
                catch (Exception)
                {
                    // 统计体积失败不影响卸载项，跳过该文件。
                }
            }

            var kb = bytes / 1024;
            return kb > int.MaxValue ? int.MaxValue : (int)kb;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static string? ReadRegistryString(string keyPath, string? valueName)
    {
        using var key = Registry.CurrentUser.OpenSubKey(keyPath);
        return key?.GetValue(valueName) as string;
    }

    private static ProcessResult RunProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        int timeoutMs)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            StandardErrorEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
        };

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                throw new SetupException($"无法启动进程：{fileName}");
            }
        }
        catch (Win32Exception exception)
        {
            throw new SetupException($"无法启动 {fileName}：{exception.Message}", exception);
        }

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();

        if (!process.WaitForExit(timeoutMs))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception)
            {
                // 已经退出/无权限时忽略，下面仍抛出超时。
            }

            throw new SetupException(
                $"{Path.GetFileName(fileName)} {arguments} 超时（{timeoutMs / 1000} 秒）。");
        }

        try
        {
            Task.WaitAll(new Task[] { stdout, stderr }, 5_000);
        }
        catch (AggregateException)
        {
            // 读取失败时仍按退出码返回；输出丢失不改变成功/失败。
        }

        var output = (stdout.IsCompleted ? stdout.Result : string.Empty)
                     + (stderr.IsCompleted ? stderr.Result : string.Empty);
        return new ProcessResult(process.ExitCode, output.Trim());
    }

    private static SetupResult Failure(string installDir, string message, List<string> warnings)
        => new(
            Success: false,
            InstallDir: installDir,
            ExePath: string.IsNullOrEmpty(installDir) ? string.Empty : SetupLogic.GetExePath(installDir),
            AssociationRequested: false,
            AssociationSucceeded: false,
            AssociationExitCode: null,
            AssociationOutput: null,
            IsDefaultProgram: false,
            NeedsDefaultAppConfirmation: false,
            StartMenuShortcutCreated: false,
            DesktopShortcutCreated: false,
            UninstallEntryWritten: false,
            Launched: false,
            ErrorMessage: message,
            Warnings: warnings);

    /// <summary>把异常翻译成可读中文（权限/占用单独提示）。</summary>
    internal static string Describe(Exception exception)
    {
        if (exception is SetupException)
        {
            return exception.Message;
        }

        if (exception is UnauthorizedAccessException)
        {
            return "没有权限完成安装操作（目录或注册表受保护）。"
                   + (string.IsNullOrWhiteSpace(exception.Message)
                       ? "请选择其它目录，或用有权限的账户运行安装程序。"
                       : $"详情：{exception.Message}");
        }

        if (exception is IOException io && IsSharingViolation(io))
        {
            return "文件被占用（请先关闭鲸鲸阅读器后重试）。";
        }

        return exception.Message;
    }

    private static bool IsSharingViolation(IOException exception)
    {
        var code = unchecked((uint)exception.HResult);
        // ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33)
        return code is 0x80070020 or 0x80070021;
    }

    private sealed record ProcessResult(int ExitCode, string Output);
}

/// <summary>
/// WScript.Shell 快捷方式创建。COM 对象在独立 STA 线程上创建/调用，
/// 这样 UI 线程和 Task.Run 线程池（MTA）都能安全调用。
/// </summary>
internal static class Shortcut
{
    public static void Create(
        string shortcutPath,
        string targetPath,
        string workingDirectory,
        string description,
        string iconPath)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                CreateCore(shortcutPath, targetPath, workingDirectory, description, iconPath);
            }
            catch (Exception exception)
            {
                failure = exception;
            }
        })
        {
            IsBackground = true,
            Name = "JingjingReaderSetup.Shortcut",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    private static void CreateCore(
        string shortcutPath,
        string targetPath,
        string workingDirectory,
        string description,
        string iconPath)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
                        ?? throw new SetupException("系统未注册 WScript.Shell，无法创建快捷方式。");

        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType)
                    ?? throw new SetupException("无法创建 WScript.Shell 对象。");
            dynamic shellObject = shell;
            shortcut = shellObject.CreateShortcut(shortcutPath);
            dynamic shortcutObject = shortcut;
            shortcutObject.TargetPath = targetPath;
            shortcutObject.WorkingDirectory = workingDirectory;
            shortcutObject.Description = description;
            shortcutObject.IconLocation = iconPath + ",0";
            shortcutObject.Save();
        }
        catch (Exception exception) when (exception is not SetupException)
        {
            throw new SetupException($"创建快捷方式失败：{exception.Message}", exception);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut))
            {
                try
                {
                    Marshal.FinalReleaseComObject(shortcut);
                }
                catch (Exception)
                {
                    // 释放失败不影响已保存的 .lnk。
                }
            }

            if (shell is not null && Marshal.IsComObject(shell))
            {
                try
                {
                    Marshal.FinalReleaseComObject(shell);
                }
                catch (Exception)
                {
                    // 同上。
                }
            }
        }
    }
}
