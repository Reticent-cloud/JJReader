using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace JingjingReader;

/// <summary>
/// 便于单测的注册表抽象：只覆盖 .md 关联需要的读/写/删除能力。
/// 在 brief 的三方法之外扩展了 <see cref="DeleteValue"/>、<see cref="KeyExists"/> 与
/// <see cref="ReadValues"/>：卸载只能删「打开方式」里的值（不能删整棵 .md 键）、
/// 安装要判断 ProgID 键是否已存在、卸载要按安装前的快照恢复 ProgID 子树。
/// </summary>
public interface IAssocRegistry
{
    /// <summary>读值；键/值不存在时返回 null（不抛异常）。valueName 为 null 表示默认值。</summary>
    string? GetValue(string keyPath, string? valueName);

    /// <summary>写字符串值；键不存在时创建（默认值用 null 值名）。</summary>
    void SetValue(string keyPath, string? valueName, string value);

    /// <summary>删除整棵键（不存在时忽略）。</summary>
    void DeleteKey(string keyPath);

    /// <summary>删除单个值（键或值不存在时忽略）；若删完键已空，适配器会尽力删除空键。</summary>
    void DeleteValue(string keyPath, string? valueName);

    /// <summary>键是否存在。</summary>
    bool KeyExists(string keyPath);

    /// <summary>
    /// 递归读取键树中的全部值（快照/恢复 ProgID 子树用）。键不存在时返回空列表。
    /// 非字符串类型的值以 <c>Supported=false</c> 返回：string 接口无法如实还原它们。
    /// </summary>
    IReadOnlyList<AssocRegistryValue> ReadValues(string keyPath);
}

/// <summary>注册表键树中的一个值（默认值的 <paramref name="ValueName"/> 为 null）。</summary>
public sealed record AssocRegistryValue(string KeyPath, string? ValueName, bool Supported, string? Value);

/// <summary>安装前状态的备份（assoc-backup.json，schemaVersion 1）。</summary>
public sealed record AssocBackup(
    int SchemaVersion,
    string ExePath,
    string? DotMdDefault,
    // 区分「安装前没有默认值」与「安装前默认值是空串」：两者值都为 null/""，恢复动作不同。
    bool DotMdDefaultPresent,
    bool HadOpenWithProgid,
    bool HadProgIdKey,
    // 安装前 ProgID 子树的完整值快照（hadProgIdKey=false 时为空数组）。
    AssocRegistryValue[]? ProgIdSnapshot,
    // M4：安装前 OpenWithProgids\JingjingReader.md 的原值（HadOpenWithProgid=true 时有效；
    // 旧备份缺该字段时反序列化为 null，卸载按空串恢复「值存在」）。
    string? OpenWithProgidValue,
    string BackedUpAt);

/// <summary>卸载结果：CLI 据此区分「已恢复」「备份缺失」「备份不可用」三种文案。</summary>
public enum AssocUninstallResult
{
    /// <summary>读到有效备份，已按快照恢复安装前状态。</summary>
    RestoredFromBackup,

    /// <summary>没有备份：已删除本程序写入的关联项（无法还原安装前 ProgID 细节）。</summary>
    RemovedWithoutBackup,

    /// <summary>备份 JSON 损坏：没有改动注册表，也没有删除备份。</summary>
    BackupCorrupt,

    /// <summary>备份 schemaVersion 不受支持：没有改动注册表，也没有删除备份。</summary>
    BackupIncompatible,
}

/// <summary>
/// Task 16：<c>.md</c> 文件关联的安装/卸载逻辑（不直接碰注册表，全部经 <see cref="IAssocRegistry"/>）。
/// 只写 HKCU\Software\Classes；安装前把「.md 默认值是否有值 / 默认值本身 / OpenWithProgids 里我们的值 /
/// ProgID 键是否存在及其子树值」原子写入备份 JSON，卸载时据此恢复——不覆盖用户已有的默认程序
/// （Win10/11 不允许程序静默抢占），也不删除安装前就存在的 ProgID 子树。
/// </summary>
public static class Assoc
{
    /// <summary>ProgID（Global Constraints：<c>JingjingReader.md</c>）。</summary>
    public const string ProgId = "JingjingReader.md";

    /// <summary>「打开方式」里显示的友好名。</summary>
    public const string FriendlyName = "鲸鲸阅读器";

    /// <summary>命令行安装/卸载的跨进程互斥名（Global 命名空间；创建无权限时辅助方法退化到 Local）。</summary>
    public const string CommandMutexName = @"Global\JingjingReader.Assoc";

    private const int BackupSchemaVersion = 1;

    private const string ClassesRoot = @"Software\Classes";

    /// <summary>安装/卸载命令最多等待另一个命令 5 秒（手工双击两次安装的常见冲突窗口）。</summary>
    private static readonly TimeSpan CommandMutexTimeout = TimeSpan.FromSeconds(5);

    /// <summary>备份 JSON 的时间戳格式（与 Store 一致：UTC ISO 8601 秒精度）。</summary>
    private const string TimeFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'";

    private static readonly JsonSerializerOptions BackupJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>ProgID 键：<c>Software\Classes\JingjingReader.md</c>。</summary>
    public static string ProgIdKey() => ClassesRoot + @"\" + ProgId;

    /// <summary><c>.md</c> 扩展名键：<c>Software\Classes\.md</c>。</summary>
    public static string DotMdKey() => ClassesRoot + @"\.md";

    /// <summary><c>.md</c> 的「打开方式」列表键：<c>Software\Classes\.md\OpenWithProgids</c>。</summary>
    public static string OpenWithProgidsKey() => DotMdKey() + @"\OpenWithProgids";

    /// <summary>
    /// M5：Win10/11 用户显式选择默认程序时写入的 UserChoice 键
    /// （<c>HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice</c>）。
    /// </summary>
    public static string UserChoiceKey()
        => @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice";

    /// <summary>shell\open\command 的值：<c>"C:\…\JingjingReader.exe" "%1"</c>。</summary>
    public static string CommandValue(string exePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exePath);
        return $"\"{exePath}\" \"%1\"";
    }

    /// <summary>
    /// 当前关联状态：Registered = <c>.md\OpenWithProgids</c> 里有本程序。
    /// IsDefault（M5）：优先看 <c>FileExts\.md\UserChoice\ProgId</c>（Win10/11 用户实际生效的默认程序），
    /// 没有 UserChoice 时才回退到 <c>Software\Classes\.md</c> 默认值——只看后者会把「用户已改默认」误报成默认。
    /// </summary>
    public static (bool Registered, bool IsDefault) GetState(IAssocRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        var registered = registry.GetValue(OpenWithProgidsKey(), ProgId) is not null;
        var userChoice = registry.GetValue(UserChoiceKey(), "ProgId");
        var effectiveDefault = string.IsNullOrWhiteSpace(userChoice)
            ? registry.GetValue(DotMdKey(), null)
            : userChoice;
        var isDefault = string.Equals(effectiveDefault, ProgId, StringComparison.OrdinalIgnoreCase);
        return (registered, isDefault);
    }

    /// <summary>
    /// 安装：先备份安装前状态（含 ProgID 子树值快照），再写 ProgID（友好名 / DefaultIcon /
    /// shell\open\command）、<c>.md\OpenWithProgids</c> 与（原本没有默认程序时的）<c>.md</c> 默认值。
    /// 已有其它默认程序时不覆盖；重复安装不会用安装后的状态覆盖原始备份。
    /// </summary>
    public static void Install(IAssocRegistry registry, string exePath, string backupJsonPath)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentException.ThrowIfNullOrWhiteSpace(exePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(backupJsonPath);

        var dotMdDefault = registry.GetValue(DotMdKey(), null);
        var dotMdDefaultPresent = dotMdDefault is not null;
        var openWithProgidValue = registry.GetValue(OpenWithProgidsKey(), ProgId);
        var hadOpenWithProgid = openWithProgidValue is not null;
        var hadProgIdKey = registry.KeyExists(ProgIdKey());

        // 只在没有备份时写：否则重复安装会把「安装后的状态」当成安装前状态，卸载无法恢复原默认程序。
        if (!File.Exists(backupJsonPath))
        {
            var snapshot = hadProgIdKey
                ? registry.ReadValues(ProgIdKey())
                : Array.Empty<AssocRegistryValue>();
            var backup = new AssocBackup(
                BackupSchemaVersion,
                exePath,
                dotMdDefault,
                dotMdDefaultPresent,
                hadOpenWithProgid,
                hadProgIdKey,
                snapshot.ToArray(),
                openWithProgidValue,
                DateTimeOffset.UtcNow.ToString(TimeFormat, CultureInfo.InvariantCulture));
            WriteBackup(backupJsonPath, backup);
        }

        registry.SetValue(ProgIdKey(), null, FriendlyName);
        // DefaultIcon 的值是 "<exe>,0"；路径含空格时 Windows 要求 exe 部分带引号。
        registry.SetValue(ProgIdKey() + @"\DefaultIcon", null, $"\"{exePath}\",0");
        registry.SetValue(ProgIdKey() + @"\shell\open\command", null, CommandValue(exePath));
        registry.SetValue(OpenWithProgidsKey(), ProgId, string.Empty);

        // Win10/11：.md 已有默认程序时只加「打开方式」，不静默抢占；没有默认程序才写默认值。
        if (string.IsNullOrEmpty(dotMdDefault))
        {
            registry.SetValue(DotMdKey(), null, ProgId);
        }
    }

    /// <summary>
    /// 卸载：按备份恢复安装前状态——
    /// 安装前没有 ProgID 键 → 删除整棵键；有 → 写回快照值、删除安装前不存在的值。
    /// 然后删除 <c>.md\OpenWithProgids</c> 里的本程序值，并只在 <c>.md</c> 默认值仍指向本程序时
    /// 恢复备份默认值（备份默认值本身就是本 ProgID 的旧残留时删除它，避免悬空默认程序）。
    /// 备份缺失时尽力删除本程序写入的键值；备份损坏/版本不兼容时不做任何注册表改动、也不删备份。
    /// </summary>
    public static AssocUninstallResult Uninstall(IAssocRegistry registry, string backupJsonPath)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentException.ThrowIfNullOrWhiteSpace(backupJsonPath);

        var (status, backup) = ReadBackup(backupJsonPath);
        switch (status)
        {
            case BackupReadStatus.Corrupt:
                return AssocUninstallResult.BackupCorrupt;
            case BackupReadStatus.Incompatible:
                return AssocUninstallResult.BackupIncompatible;
        }

        RestoreProgId(registry, backup);
        RestoreOpenWithProgid(registry, backup);
        RestoreDotMdDefault(registry, backup);

        if (File.Exists(backupJsonPath))
        {
            File.Delete(backupJsonPath);
        }

        return backup is null
            ? AssocUninstallResult.RemovedWithoutBackup
            : AssocUninstallResult.RestoredFromBackup;
    }

    /// <summary>
    /// 安装/卸载命令行使用的跨进程互斥：拿到锁返回可释放句柄，5 秒内拿不到返回 null。
    /// 用命名 Mutex（普通 lock 只能互斥同一进程）；<c>Global\</c> 无权限时退化到 <c>Local\</c>。
    /// </summary>
    public static IDisposable? TryAcquireCommandMutex() => TryAcquireMutex(CommandMutexName, CommandMutexTimeout);

    /// <summary>按指定名字与超时获取命名互斥（公开给单测；安装/卸载默认用 <see cref="CommandMutexName"/>）。</summary>
    public static IDisposable? TryAcquireMutex(string mutexName, TimeSpan timeout)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(mutexName);
        if (timeout < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "超时不能为负数。");
        }

        var mutex = CreateMutex(mutexName);
        try
        {
            bool acquired;
            try
            {
                acquired = mutex.WaitOne(timeout);
            }
            catch (AbandonedMutexException)
            {
                // 上一个持有者异常退出：锁已归我们所有，视为获取成功。
                acquired = true;
            }

            if (!acquired)
            {
                mutex.Dispose();
                return null;
            }

            return new MutexLease(mutex);
        }
        catch (Exception)
        {
            mutex.Dispose();
            throw;
        }
    }

    private static Mutex CreateMutex(string mutexName)
    {
        try
        {
            return new Mutex(initiallyOwned: false, mutexName);
        }
        catch (UnauthorizedAccessException) when (mutexName.StartsWith(@"Global\", StringComparison.OrdinalIgnoreCase))
        {
            // 受限账户可能没有创建 Global 对象的内核权限；同一会话内 Local 仍能互斥安装/卸载命令。
            return new Mutex(initiallyOwned: false, @"Local\" + mutexName[@"Global\".Length..]);
        }
    }

    /// <summary>按备份恢复 ProgID 键；backup 为 null（备份缺失）时尽力删除本程序创建的整棵键。</summary>
    private static void RestoreProgId(IAssocRegistry registry, AssocBackup? backup)
    {
        if (backup is null || !backup.HadProgIdKey)
        {
            // 安装前没有该键（或没有备份可判断）：整棵键都是本程序建的，直接删除。
            if (registry.KeyExists(ProgIdKey()))
            {
                registry.DeleteKey(ProgIdKey());
            }

            return;
        }

        var snapshot = backup.ProgIdSnapshot ?? Array.Empty<AssocRegistryValue>();
        var snapshotNames = new HashSet<string>(
            snapshot.Select(entry => ValueKey(entry.KeyPath, entry.ValueName)),
            StringComparer.OrdinalIgnoreCase);

        // 我们固定写这三个值；安装前快照里没有的，说明是本程序新增的，要删掉。
        foreach (var (keyPath, valueName) in KnownProgIdValues())
        {
            if (!snapshotNames.Contains(ValueKey(keyPath, valueName)))
            {
                registry.DeleteValue(keyPath, valueName);
            }
        }

        // 安装前存在的值（含 shell\edit、PersistentHandler 等子键值）按快照写回；
        // 非字符串类型无法用 string 接口还原，保留当前值（快照里已标记 supported=false）。
        foreach (var entry in snapshot)
        {
            if (entry.Supported)
            {
                registry.SetValue(entry.KeyPath, entry.ValueName, entry.Value ?? string.Empty);
            }
        }
    }

    /// <summary>
    /// M4：恢复 <c>.md\OpenWithProgids\JingjingReader.md</c>：安装前有该值 → 写回原值
    /// （旧备份没有值字段时按空串恢复「值存在」）；安装前没有 → 删除本程序新增的值。
    /// </summary>
    private static void RestoreOpenWithProgid(IAssocRegistry registry, AssocBackup? backup)
    {
        if (backup is not null && backup.HadOpenWithProgid)
        {
            registry.SetValue(OpenWithProgidsKey(), ProgId, backup.OpenWithProgidValue ?? string.Empty);
            return;
        }

        registry.DeleteValue(OpenWithProgidsKey(), ProgId);
    }

    /// <summary>
    /// <c>.md</c> 默认值恢复：只在它仍指向本程序时动手（用户期间改成别的程序则不动）。
    /// 备份默认值就是本 ProgID（旧残留）或安装前没有默认值时删除该值，避免留下悬空默认程序。
    /// </summary>
    private static void RestoreDotMdDefault(IAssocRegistry registry, AssocBackup? backup)
    {
        var currentDefault = registry.GetValue(DotMdKey(), null);
        if (!string.Equals(currentDefault, ProgId, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (backup is null)
        {
            // 没有备份：无法知道安装前是否有默认程序，删掉本程序写的值，至少不留下悬空默认程序。
            registry.DeleteValue(DotMdKey(), null);
            return;
        }

        if (string.Equals(backup.DotMdDefault, ProgId, StringComparison.OrdinalIgnoreCase))
        {
            // 旧版本可能把本 ProgID 当成「安装前默认值」写入备份；恢复它会指向即将消失的 ProgID。
            registry.DeleteValue(DotMdKey(), null);
            return;
        }

        // 兼容旧备份（没有 dotMdDefaultPresent 字段）：dotMdDefault 非 null 视为安装前存在该值。
        var present = backup.DotMdDefaultPresent || backup.DotMdDefault is not null;
        if (present)
        {
            registry.SetValue(DotMdKey(), null, backup.DotMdDefault ?? string.Empty);
        }
        else
        {
            registry.DeleteValue(DotMdKey(), null);
        }
    }

    private static IEnumerable<(string KeyPath, string? ValueName)> KnownProgIdValues()
    {
        yield return (ProgIdKey(), null);
        yield return (ProgIdKey() + @"\DefaultIcon", null);
        yield return (ProgIdKey() + @"\shell\open\command", null);
    }

    private static string ValueKey(string keyPath, string? valueName) => keyPath + "\0" + (valueName ?? string.Empty);

    /// <summary>原子写备份：先写 .tmp 再 File.Move 覆盖，避免中途断电留下半个 JSON。</summary>
    private static void WriteBackup(string backupJsonPath, AssocBackup backup)
    {
        var directory = Path.GetDirectoryName(backupJsonPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var tmp = backupJsonPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(backup, BackupJsonOptions), Utf8NoBom);
        File.Move(tmp, backupJsonPath, overwrite: true);
    }

    private enum BackupReadStatus
    {
        Missing,
        Valid,
        Corrupt,
        Incompatible,
    }

    /// <summary>
    /// 读备份：缺失 → Missing；JSON 损坏 → Corrupt；schemaVersion 不为 1 → Incompatible。
    /// 后两种都要求调用方「不改注册表、不删备份」。
    /// </summary>
    private static (BackupReadStatus Status, AssocBackup? Backup) ReadBackup(string backupJsonPath)
    {
        if (!File.Exists(backupJsonPath))
        {
            return (BackupReadStatus.Missing, null);
        }

        try
        {
            var backup = JsonSerializer.Deserialize<AssocBackup>(
                File.ReadAllText(backupJsonPath),
                BackupJsonOptions);
            if (backup is null)
            {
                return (BackupReadStatus.Corrupt, null);
            }

            return backup.SchemaVersion == BackupSchemaVersion
                ? (BackupReadStatus.Valid, backup)
                : (BackupReadStatus.Incompatible, backup);
        }
        catch (Exception exception) when (exception is JsonException or NotSupportedException)
        {
            return (BackupReadStatus.Corrupt, null);
        }
    }

    /// <summary>持有已获取的命名 Mutex，Dispose 时释放并关闭句柄。</summary>
    private sealed class MutexLease : IDisposable
    {
        private Mutex? _mutex;

        public MutexLease(Mutex mutex) => _mutex = mutex;

        public void Dispose()
        {
            var mutex = Interlocked.Exchange(ref _mutex, null);
            if (mutex is null)
            {
                return;
            }

            try
            {
                mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // 跨线程释放会失败：句柄仍要关闭，锁会随持有线程/进程退出自动释放。
            }
            finally
            {
                mutex.Dispose();
            }
        }
    }
}
