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
