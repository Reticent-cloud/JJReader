using System.IO;
using System.Text.Json;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 16：.md 文件关联（ProgID / OpenWithProgids / 默认值与 ProgID 子树快照的备份恢复）。
/// 所有注册表交互都走 FakeRegistry，测试不碰真实注册表；备份文件落在 TestDir() 临时目录。
/// </summary>
public class AssocTests
{
    private const string ExePath = @"C:\apps\JingjingReader.exe";

    private static string OpenWithKey => $@"{Assoc.DotMdKey()}\OpenWithProgids";

    private static string NewBackupPath() => Path.Combine(TestHelpers.TestDir(), "assoc-backup.json");

    [Fact]
    public void Command_quotes_exe_and_percent_1()
    {
        Assert.Equal("\"C:\\apps\\JingjingReader.exe\" \"%1\"", Assoc.CommandValue(ExePath));
    }

    [Fact]
    public void Constants_use_expected_progid_and_hkcu_classes_paths()
    {
        Assert.Equal("JingjingReader.md", Assoc.ProgId);
        Assert.Equal("鲸鲸阅读器", Assoc.FriendlyName);
        Assert.Equal(@"Software\Classes\JingjingReader.md", Assoc.ProgIdKey());
        Assert.Equal(@"Software\Classes\.md", Assoc.DotMdKey());
    }

    [Fact]
    public void Install_writes_progid_openwith_and_backup()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        Assert.Equal(Assoc.FriendlyName, reg.GetValue(Assoc.ProgIdKey(), null));
        // DefaultIcon 的 exe 部分必须带引号（路径含空格时 Windows 才能解析）。
        Assert.Equal($"\"{ExePath}\",0", reg.GetValue(Assoc.ProgIdKey() + @"\DefaultIcon", null));
        Assert.Equal(Assoc.CommandValue(ExePath), reg.GetValue(Assoc.ProgIdKey() + @"\shell\open\command", null));
        Assert.Equal(string.Empty, reg.GetValue(OpenWithKey, Assoc.ProgId));
        // .md 原来没有默认程序：安装后可成为默认程序
        Assert.Equal(Assoc.ProgId, reg.GetValue(Assoc.DotMdKey(), null));
        Assert.True(File.Exists(backup));

        using var document = JsonDocument.Parse(File.ReadAllText(backup));
        var root = document.RootElement;
        Assert.False(root.GetProperty("dotMdDefaultPresent").GetBoolean());
        Assert.False(root.GetProperty("hadProgIdKey").GetBoolean());
        Assert.Equal(0, root.GetProperty("progIdSnapshot").GetArrayLength());
    }

    [Fact]
    public void Install_backs_up_previous_state()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        reg.SetValue(OpenWithKey, "WorkBuddy.md", string.Empty);
        // 重装场景：我们的 ProgID 值/键在安装前已存在（备份要如实记录，卸载时按快照恢复）。
        reg.SetValue(OpenWithKey, Assoc.ProgId, string.Empty);
        reg.SetValue(Assoc.ProgIdKey(), null, "旧 ProgID");
        reg.SetValue(Assoc.ProgIdKey() + @"\DefaultIcon", null, @"C:\old\old.exe,0");
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        using var document = JsonDocument.Parse(File.ReadAllText(backup));
        var root = document.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(ExePath, root.GetProperty("exePath").GetString());
        Assert.Equal("WorkBuddy.md", root.GetProperty("dotMdDefault").GetString());
        Assert.True(root.GetProperty("dotMdDefaultPresent").GetBoolean());
        Assert.True(root.GetProperty("hadOpenWithProgid").GetBoolean());
        Assert.True(root.GetProperty("hadProgIdKey").GetBoolean());
        Assert.Equal(2, root.GetProperty("progIdSnapshot").GetArrayLength());
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("backedUpAt").GetString()));
    }

    [Fact]
    public void Install_does_not_override_existing_default_program()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        Assert.Equal("WorkBuddy.md", reg.GetValue(Assoc.DotMdKey(), null));
        var state = Assoc.GetState(reg);
        Assert.True(state.Registered);
        Assert.False(state.IsDefault);
    }

    [Fact]
    public void Reinstall_keeps_original_backup()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);
        var first = File.ReadAllText(backup);
        // 用户把我们设为默认后再跑一次安装：不能把「安装后状态」覆盖成备份，否则卸载无法恢复安装前默认。
        reg.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);
        Assoc.Install(reg, ExePath, backup);

        Assert.Equal(first, File.ReadAllText(backup));
    }

    [Fact]
    public void Uninstall_restores_previous_default_and_removes_keys()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        reg.SetValue(OpenWithKey, "WorkBuddy.md", string.Empty);
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.Null(reg.GetValue(OpenWithKey, Assoc.ProgId));
        Assert.Equal("WorkBuddy.md", reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void Uninstall_removes_default_when_there_was_none_before_install()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        Assert.Equal(Assoc.ProgId, reg.GetValue(Assoc.DotMdKey(), null));

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        Assert.Null(reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        // OpenWithProgids 删空后键也删除（与 Win32 适配器的空键清理语义一致）。
        Assert.False(reg.KeyExists(OpenWithKey));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void Uninstall_keeps_default_changed_by_user_after_install()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        reg.SetValue(Assoc.DotMdKey(), null, "VSCode.md");

        Assoc.Uninstall(reg, backup);

        Assert.Equal("VSCode.md", reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
    }

    [Fact]
    public void Uninstall_without_backup_best_effort_removes_what_it_wrote()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        File.Delete(backup);

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RemovedWithoutBackup, result);
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.Null(reg.GetValue(OpenWithKey, Assoc.ProgId));
        Assert.Null(reg.GetValue(Assoc.DotMdKey(), null));
    }

    [Fact]
    public void Uninstall_is_idempotent_when_nothing_was_installed()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RemovedWithoutBackup, result);
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void Uninstall_restores_existing_progid_subtree_from_snapshot()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        reg.SetValue(OpenWithKey, "WorkBuddy.md", string.Empty);
        reg.SetValue(Assoc.ProgIdKey(), null, "旧 ProgID");
        reg.SetValue(Assoc.ProgIdKey() + @"\DefaultIcon", null, @"C:\old\old.exe,0");
        reg.SetValue(Assoc.ProgIdKey() + @"\shell\open\command", null, "\"C:\\old\\old.exe\" \"%1\"");
        reg.SetValue(Assoc.ProgIdKey() + @"\shell\edit\command", null, "\"C:\\old\\editor.exe\" \"%1\"");
        reg.SetValue(Assoc.ProgIdKey() + @"\PersistentHandler", null, "{11111111-1111-1111-1111-111111111111}");
        var original = Snapshot(reg, Assoc.ProgIdKey());
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        // 安装确实覆盖了我们写的值，但备份里保留了完整子树快照。
        Assert.Equal(Assoc.FriendlyName, reg.GetValue(Assoc.ProgIdKey(), null));
        using (var document = JsonDocument.Parse(File.ReadAllText(backup)))
        {
            Assert.Equal(5, document.RootElement.GetProperty("progIdSnapshot").GetArrayLength());
        }

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        Assert.Equal(original, Snapshot(reg, Assoc.ProgIdKey()));
        Assert.Equal("WorkBuddy.md", reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void Uninstall_deletes_whole_progid_key_when_absent_before_install()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        Assert.True(reg.KeyExists(Assoc.ProgIdKey()));

        Assoc.Uninstall(reg, backup);

        // 安装前不存在 → 卸载后整棵子树都不存在（不保留任何空壳键）。
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.Empty(reg.ReadValues(Assoc.ProgIdKey()));
        Assert.DoesNotContain(
            reg.AllKeyPaths,
            path => path.StartsWith(Assoc.ProgIdKey() + @"\", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Uninstall_removes_default_when_backup_default_is_our_progid()
    {
        var reg = new FakeRegistry();
        // 旧残留：安装前 .md 默认值已经是本 ProgID（例如上次卸载没清理干净）。
        reg.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        // 不能把 .md 默认值「恢复」成即将消失的 ProgID（悬空默认程序）。
        Assert.Null(reg.GetValue(Assoc.DotMdKey(), null));
    }

    [Fact]
    public void Uninstall_restores_default_from_legacy_backup_without_present_flag()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);
        var backup = NewBackupPath();
        // 旧版备份没有 dotMdDefaultPresent 字段：dotMdDefault 非 null 仍应视为「安装前存在该值」。
        File.WriteAllText(backup, """
        {
          "schemaVersion": 1,
          "exePath": "C:\\apps\\JingjingReader.exe",
          "dotMdDefault": "WorkBuddy.md",
          "hadOpenWithProgid": false,
          "hadProgIdKey": false,
          "backedUpAt": "2026-10-17T00:00:00Z"
        }
        """);

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        Assert.Equal("WorkBuddy.md", reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(File.Exists(backup));
    }

    [Fact]
    public void Uninstall_leaves_registry_untouched_when_backup_is_corrupt()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        var before = Snapshot(reg, Assoc.DotMdKey(), Assoc.ProgIdKey());
        var corrupt = "{ this is not valid json ]";
        File.WriteAllText(backup, corrupt);

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.BackupCorrupt, result);
        Assert.Equal(before, Snapshot(reg, Assoc.DotMdKey(), Assoc.ProgIdKey()));
        Assert.True(File.Exists(backup));
        Assert.Equal(corrupt, File.ReadAllText(backup));
    }

    [Fact]
    public void Uninstall_leaves_registry_untouched_when_backup_schema_is_incompatible()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();
        Assoc.Install(reg, ExePath, backup);
        var before = Snapshot(reg, Assoc.DotMdKey(), Assoc.ProgIdKey());
        File.WriteAllText(backup, JsonSerializer.Serialize(new
        {
            schemaVersion = 2,
            exePath = ExePath,
            dotMdDefault = (string?)null,
            dotMdDefaultPresent = false,
            hadOpenWithProgid = false,
            hadProgIdKey = false,
            progIdSnapshot = Array.Empty<object>(),
            backedUpAt = "2026-10-17T00:00:00Z",
        }));

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.BackupIncompatible, result);
        Assert.Equal(before, Snapshot(reg, Assoc.DotMdKey(), Assoc.ProgIdKey()));
        Assert.True(File.Exists(backup));
    }

    [Fact]
    public void Backup_distinguishes_empty_default_from_missing_value()
    {
        var reg = new FakeRegistry();
        // 空串默认值 = 值存在但数据为空；与「没有默认值」恢复动作不同。
        reg.SetValue(Assoc.DotMdKey(), null, string.Empty);
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        using (var document = JsonDocument.Parse(File.ReadAllText(backup)))
        {
            var root = document.RootElement;
            Assert.Equal(string.Empty, root.GetProperty("dotMdDefault").GetString());
            Assert.True(root.GetProperty("dotMdDefaultPresent").GetBoolean());
        }

        var result = Assoc.Uninstall(reg, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, result);
        // 恢复为空串（值存在），而不是删除值。
        Assert.Equal(string.Empty, reg.GetValue(Assoc.DotMdKey(), null));
    }

    [Fact]
    public void GetState_reports_registered_and_default()
    {
        var reg = new FakeRegistry();
        Assert.Equal((false, false), Assoc.GetState(reg));

        reg.SetValue(OpenWithKey, Assoc.ProgId, string.Empty);
        Assert.Equal((true, false), Assoc.GetState(reg));

        reg.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);
        Assert.Equal((true, true), Assoc.GetState(reg));
    }

    [Fact]
    public void GetState_ignores_unrelated_values()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "Other.md");
        reg.SetValue(OpenWithKey, "Other.md", string.Empty);

        Assert.Equal((false, false), Assoc.GetState(reg));
    }

    [Fact]
    public void Install_and_Uninstall_reject_missing_arguments()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();

        Assert.Throws<ArgumentNullException>(() => Assoc.Install(null!, ExePath, backup));
        Assert.Throws<ArgumentException>(() => Assoc.Install(reg, " ", backup));
        Assert.Throws<ArgumentException>(() => Assoc.Install(reg, ExePath, " "));
        Assert.Throws<ArgumentNullException>(() => Assoc.Uninstall(null!, backup));
        Assert.Throws<ArgumentException>(() => Assoc.Uninstall(reg, " "));
    }

    [Fact]
    public void TryAcquireMutex_blocks_until_holder_releases()
    {
        var name = @"Local\JingjingReader.Tests." + Guid.NewGuid().ToString("N");
        using var acquired = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var holder = new Thread(() =>
        {
            using var mutex = new Mutex(initiallyOwned: false, name);
            mutex.WaitOne();
            acquired.Set();
            release.Wait(TimeSpan.FromSeconds(10));
            mutex.ReleaseMutex();
        })
        {
            IsBackground = true,
        };
        holder.Start();
        Assert.True(acquired.Wait(TimeSpan.FromSeconds(10)));

        Assert.Null(Assoc.TryAcquireMutex(name, TimeSpan.Zero));

        release.Set();
        Assert.True(holder.Join(TimeSpan.FromSeconds(10)));

        using var lease = Assoc.TryAcquireMutex(name, TimeSpan.FromSeconds(2));
        Assert.NotNull(lease);
    }

    /// <summary>把若干键树的值拍平成「键路径\0值名\0数据」并排序，便于整体比较。</summary>
    private static List<string> Snapshot(FakeRegistry registry, params string[] keyPaths)
        => keyPaths
            .SelectMany(registry.ReadValues)
            .Select(value => $"{value.KeyPath}\0{value.ValueName ?? "(default)"}\0{value.Value}")
            .OrderBy(line => line, StringComparer.OrdinalIgnoreCase)
            .ToList();
}

/// <summary>
/// 内存版注册表：路径/值名大小写不敏感，支持默认值（null 值名）、键树删除与存在性判断。
/// 键集合与值集合分开维护：<c>CreateSubKey</c> 会创建中间键，删掉键里最后一个值且无子键时
/// 删除该空键（与 <see cref="Win32AssocRegistry.DeleteValue"/> 的 PruneIfEmpty 语义一致）。
/// </summary>
internal sealed class FakeRegistry : IAssocRegistry
{
    private const string DefaultValueName = "";

    private readonly HashSet<string> _keys = new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, Dictionary<string, string>> _values =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>测试断言用：当前存在的全部键路径。</summary>
    public IReadOnlyCollection<string> AllKeyPaths => _keys;

    public string? GetValue(string keyPath, string? valueName)
        => _values.TryGetValue(keyPath, out var values)
            && values.TryGetValue(NormalizeName(valueName), out var value)
            ? value
            : null;

    public void SetValue(string keyPath, string? valueName, string value)
    {
        EnsureKey(keyPath);
        if (!_values.TryGetValue(keyPath, out var values))
        {
            values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            _values[keyPath] = values;
        }

        values[NormalizeName(valueName)] = value;
    }

    public void DeleteKey(string keyPath)
    {
        var prefix = keyPath + "\\";
        foreach (var target in _keys
            .Where(path => string.Equals(path, keyPath, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .ToList())
        {
            _keys.Remove(target);
        }

        foreach (var target in _values.Keys
            .Where(path => string.Equals(path, keyPath, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .ToList())
        {
            _values.Remove(target);
        }
    }

    public void DeleteValue(string keyPath, string? valueName)
    {
        if (_values.TryGetValue(keyPath, out var values))
        {
            values.Remove(NormalizeName(valueName));
            if (values.Count == 0)
            {
                _values.Remove(keyPath);
            }
        }

        // 与 Win32 的 DeleteValue + PruneIfEmpty 一致：值删空且无子键时删除该键。
        if (KeyExists(keyPath) && !HasValues(keyPath) && !HasSubKeys(keyPath))
        {
            _keys.Remove(keyPath);
        }
    }

    public bool KeyExists(string keyPath) => _keys.Contains(keyPath);

    public IReadOnlyList<AssocRegistryValue> ReadValues(string keyPath)
    {
        var prefix = keyPath + "\\";
        return _values
            .Where(pair => string.Equals(pair.Key, keyPath, StringComparison.OrdinalIgnoreCase)
                || pair.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .SelectMany(
                pair => pair.Value.Select(
                    value => new AssocRegistryValue(
                        pair.Key,
                        value.Key.Length == 0 ? null : value.Key,
                        Supported: true,
                        value.Value)))
            .OrderBy(value => value.KeyPath, StringComparer.OrdinalIgnoreCase)
            .ThenBy(value => value.ValueName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private bool HasValues(string keyPath) => _values.ContainsKey(keyPath);

    private bool HasSubKeys(string keyPath)
    {
        var prefix = keyPath + "\\";
        return _keys.Any(path => path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>模拟 Win32 CreateSubKey：创建目标键及所有中间键（不覆盖已有值）。</summary>
    private void EnsureKey(string keyPath)
    {
        var path = keyPath;
        while (!string.IsNullOrEmpty(path))
        {
            _keys.Add(path);
            var separator = path.LastIndexOf('\\');
            if (separator <= 0)
            {
                break;
            }

            path = path[..separator];
        }
    }

    private static string NormalizeName(string? valueName) => valueName ?? DefaultValueName;
}
