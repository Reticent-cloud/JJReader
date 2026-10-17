using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace JingjingReader;

/// <summary>
/// 便于单测的注册表抽象：只覆盖 .md 关联需要的读/写/删除能力。
/// 扩展了 brief 的 <see cref="DeleteValue"/> 与 <see cref="KeyExists"/>：
/// 卸载要删除「打开方式」里的值（而不是整棵 .md 键），安装备份要判断 ProgID 键是否已存在。
/// </summary>
public interface IAssocRegistry
{
    /// <summary>读值；键/值不存在时返回 null（不抛异常）。valueName 为 null 表示默认值。</summary>
    string? GetValue(string keyPath, string? valueName);

    /// <summary>写字符串值；键不存在时创建（默认值用 null 值名）。</summary>
    void SetValue(string keyPath, string? valueName, string value);

    /// <summary>删除整棵键（不存在时忽略）。</summary>
    void DeleteKey(string keyPath);

    /// <summary>删除单个值（键或值不存在时忽略）。</summary>
    void DeleteValue(string keyPath, string? valueName);

    /// <summary>键是否存在。</summary>
    bool KeyExists(string keyPath);
}

/// <summary>安装前状态的备份（assoc-backup.json，schemaVersion 1）。</summary>
public sealed record AssocBackup(
    int SchemaVersion,
    string ExePath,
    string? DotMdDefault,
    bool HadOpenWithProgid,
    bool HadProgIdKey,
    string BackedUpAt);

/// <summary>
/// Task 16：<c>.md</c> 文件关联的安装/卸载逻辑（不直接碰注册表，全部经 <see cref="IAssocRegistry"/>）。
/// 只写 HKCU\Software\Classes；安装前把「.md 默认值 / OpenWithProgids 里我们的值 / ProgID 键是否存在」
/// 原子写入备份 JSON，卸载时据此恢复——不覆盖用户已有的默认程序（Win10/11 不允许程序静默抢占）。
/// </summary>
public static class Assoc
{
    /// <summary>ProgID（Global Constraints：<c>JingjingReader.md</c>）。</summary>
    public const string ProgId = "JingjingReader.md";

    /// <summary>「打开方式」里显示的友好名。</summary>
    public const string FriendlyName = "鲸鲸阅读器";

    private const int BackupSchemaVersion = 1;

    private const string ClassesRoot = @"Software\Classes";

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

    /// <summary>shell\open\command 的值：<c>"C:\…\JingjingReader.exe" "%1"</c>。</summary>
    public static string CommandValue(string exePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exePath);
        return $"\"{exePath}\" \"%1\"";
    }

    /// <summary>
    /// 当前关联状态：Registered = <c>.md\OpenWithProgids</c> 里有本程序；IsDefault = <c>.md</c> 默认值就是本 ProgID。
    /// </summary>
    public static (bool Registered, bool IsDefault) GetState(IAssocRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        var registered = registry.GetValue(OpenWithProgidsKey(), ProgId) is not null;
        var isDefault = string.Equals(
            registry.GetValue(DotMdKey(), null),
            ProgId,
            StringComparison.OrdinalIgnoreCase);
        return (registered, isDefault);
    }

    /// <summary>
    /// 安装：先备份安装前状态，再写 ProgID（友好名 / DefaultIcon / shell\open\command）、
    /// <c>.md\OpenWithProgids</c> 与（原本没有默认程序时的）<c>.md</c> 默认值。
    /// 已有其它默认程序时不覆盖；重复安装不会用安装后的状态覆盖原始备份。
    /// </summary>
    public static void Install(IAssocRegistry registry, string exePath, string backupJsonPath)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentException.ThrowIfNullOrWhiteSpace(exePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(backupJsonPath);

        var dotMdDefault = registry.GetValue(DotMdKey(), null);
        var hadOpenWithProgid = registry.GetValue(OpenWithProgidsKey(), ProgId) is not null;
        var hadProgIdKey = registry.KeyExists(ProgIdKey());

        // 只在没有备份时写：否则重复安装会把「安装后的状态」当成安装前状态，卸载无法恢复原默认程序。
        if (!File.Exists(backupJsonPath))
        {
            var backup = new AssocBackup(
                BackupSchemaVersion,
                exePath,
                dotMdDefault,
                hadOpenWithProgid,
                hadProgIdKey,
                DateTimeOffset.UtcNow.ToString(TimeFormat, CultureInfo.InvariantCulture));
            WriteBackup(backupJsonPath, backup);
        }

        registry.SetValue(ProgIdKey(), null, FriendlyName);
        registry.SetValue(ProgIdKey() + @"\DefaultIcon", null, exePath + ",0");
        registry.SetValue(ProgIdKey() + @"\shell\open\command", null, CommandValue(exePath));
        registry.SetValue(OpenWithProgidsKey(), ProgId, string.Empty);

        // Win10/11：.md 已有默认程序时只加「打开方式」，不静默抢占；没有默认程序才写默认值。
        if (string.IsNullOrEmpty(dotMdDefault))
        {
            registry.SetValue(DotMdKey(), null, ProgId);
        }
    }

    /// <summary>
    /// 卸载：删 ProgID 键树、删 OpenWithProgids 里的本程序值；<c>.md</c> 默认值仍指向本程序时
    /// 恢复备份值（备份为空则删除该值），用户期间改成别的程序则不动。成功后删除备份文件。
    /// 备份缺失/损坏时尽力删除本程序写入的键值。
    /// </summary>
    public static void Uninstall(IAssocRegistry registry, string backupJsonPath)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentException.ThrowIfNullOrWhiteSpace(backupJsonPath);

        var backup = TryReadBackup(backupJsonPath);

        if (registry.KeyExists(ProgIdKey()))
        {
            registry.DeleteKey(ProgIdKey());
        }

        registry.DeleteValue(OpenWithProgidsKey(), ProgId);

        var currentDefault = registry.GetValue(DotMdKey(), null);
        if (string.Equals(currentDefault, ProgId, StringComparison.OrdinalIgnoreCase))
        {
            if (!string.IsNullOrEmpty(backup?.DotMdDefault))
            {
                registry.SetValue(DotMdKey(), null, backup.DotMdDefault);
            }
            else
            {
                registry.DeleteValue(DotMdKey(), null);
            }
        }

        if (File.Exists(backupJsonPath))
        {
            File.Delete(backupJsonPath);
        }
    }

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

    /// <summary>读备份；缺失、不可读或 JSON 损坏都返回 null（按「没有备份」尽力卸载）。</summary>
    private static AssocBackup? TryReadBackup(string backupJsonPath)
    {
        try
        {
            if (!File.Exists(backupJsonPath))
            {
                return null;
            }

            return JsonSerializer.Deserialize<AssocBackup>(File.ReadAllText(backupJsonPath), BackupJsonOptions);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
