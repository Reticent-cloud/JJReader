using Microsoft.Win32;

namespace JingjingReader;

/// <summary>
/// <see cref="IAssocRegistry"/> 的 Windows 实现：只操作 <c>HKCU</c>（不需要管理员权限，也不碰 HKLM）。
/// 读不存在的键返回 null；删除不存在的键/值静默忽略。
/// </summary>
public sealed class Win32AssocRegistry : IAssocRegistry
{
    public string? GetValue(string keyPath, string? valueName)
    {
        using var key = Registry.CurrentUser.OpenSubKey(keyPath);
        return key?.GetValue(valueName) as string;
    }

    public void SetValue(string keyPath, string? valueName, string value)
    {
        using var key = Registry.CurrentUser.CreateSubKey(keyPath, writable: true)
            ?? throw new InvalidOperationException($"无法创建注册表键：{keyPath}");
        key.SetValue(valueName, value ?? string.Empty, RegistryValueKind.String);
    }

    public void DeleteKey(string keyPath)
        => Registry.CurrentUser.DeleteSubKeyTree(keyPath, throwOnMissingSubKey: false);

    public void DeleteValue(string keyPath, string? valueName)
    {
        using (var key = Registry.CurrentUser.OpenSubKey(keyPath, writable: true))
        {
            // 默认值在 .NET 里用空串名字删除（DeleteValue 不接受 null）。
            key?.DeleteValue(valueName ?? string.Empty, throwOnMissingValue: false);
        }

        // 卸载后把本次安装创建的空容器键一并清掉（.md\OpenWithProgids 只剩空壳时），
        // 尽量恢复安装前的注册表结构；键里还有别的值/子键时不动。
        PruneIfEmpty(keyPath);
    }

    public bool KeyExists(string keyPath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(keyPath);
        return key is not null;
    }

    /// <summary>
    /// 递归读取键树中的值（只读）。REG_SZ / REG_EXPAND_SZ 按 string 读取；其它类型标记
    /// <c>Supported=false</c>，卸载时无法用 string 接口如实写回，因此不会覆盖当前值。
    /// </summary>
    public IReadOnlyList<AssocRegistryValue> ReadValues(string keyPath)
    {
        var values = new List<AssocRegistryValue>();
        using var key = Registry.CurrentUser.OpenSubKey(keyPath);
        if (key is null)
        {
            return values;
        }

        CollectValues(keyPath, key, values);
        return values
            .OrderBy(value => value.KeyPath, StringComparer.OrdinalIgnoreCase)
            .ThenBy(value => value.ValueName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static void CollectValues(string keyPath, RegistryKey key, List<AssocRegistryValue> values)
    {
        foreach (var rawName in key.GetValueNames())
        {
            // .NET 用空串表示默认值；对外统一用 null 表达。
            var valueName = rawName.Length == 0 ? null : rawName;
            var kind = key.GetValueKind(rawName);
            if (kind is RegistryValueKind.String or RegistryValueKind.ExpandString)
            {
                var value = key.GetValue(rawName, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                values.Add(new AssocRegistryValue(keyPath, valueName, Supported: true, value));
            }
            else
            {
                values.Add(new AssocRegistryValue(keyPath, valueName, Supported: false, Value: null));
            }
        }

        foreach (var subKeyName in key.GetSubKeyNames())
        {
            using var subKey = key.OpenSubKey(subKeyName);
            if (subKey is not null)
            {
                CollectValues(keyPath + @"\" + subKeyName, subKey, values);
            }
        }
    }

    private static void PruneIfEmpty(string keyPath)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(keyPath);
            if (key is null || key.ValueCount > 0 || key.SubKeyCount > 0)
            {
                return;
            }

            Registry.CurrentUser.DeleteSubKey(keyPath, throwOnMissingSubKey: false);
        }
        catch (Exception)
        {
            // 清理是尽力而为：删不掉空键不影响「值已删除」的结果。
        }
    }
}
