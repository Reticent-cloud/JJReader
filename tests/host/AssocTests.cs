using System.IO;
using System.Text.Json;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 16：.md 文件关联（ProgID / OpenWithProgids / 默认值备份与恢复）。
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
        Assert.Equal(ExePath + ",0", reg.GetValue(Assoc.ProgIdKey() + @"\DefaultIcon", null));
        Assert.Equal(Assoc.CommandValue(ExePath), reg.GetValue(Assoc.ProgIdKey() + @"\shell\open\command", null));
        Assert.Equal(string.Empty, reg.GetValue(OpenWithKey, Assoc.ProgId));
        // .md 原来没有默认程序：安装后可成为默认程序
        Assert.Equal(Assoc.ProgId, reg.GetValue(Assoc.DotMdKey(), null));
        Assert.True(File.Exists(backup));
    }

    [Fact]
    public void Install_backs_up_previous_state()
    {
        var reg = new FakeRegistry();
        reg.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        reg.SetValue(OpenWithKey, "WorkBuddy.md", string.Empty);
        // 重装场景：我们的 ProgID 值/键在安装前已存在（备份要如实记录，卸载时仍按规则删除）。
        reg.SetValue(OpenWithKey, Assoc.ProgId, string.Empty);
        reg.SetValue(Assoc.ProgIdKey(), null, "旧 ProgID");
        var backup = NewBackupPath();

        Assoc.Install(reg, ExePath, backup);

        using var document = JsonDocument.Parse(File.ReadAllText(backup));
        var root = document.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(ExePath, root.GetProperty("exePath").GetString());
        Assert.Equal("WorkBuddy.md", root.GetProperty("dotMdDefault").GetString());
        Assert.True(root.GetProperty("hadOpenWithProgid").GetBoolean());
        Assert.True(root.GetProperty("hadProgIdKey").GetBoolean());
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

        Assoc.Uninstall(reg, backup);

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

        Assoc.Uninstall(reg, backup);

        Assert.Null(reg.GetValue(Assoc.DotMdKey(), null));
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
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

        Assoc.Uninstall(reg, backup);

        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.Null(reg.GetValue(OpenWithKey, Assoc.ProgId));
        Assert.Null(reg.GetValue(Assoc.DotMdKey(), null));
    }

    [Fact]
    public void Uninstall_is_idempotent_when_nothing_was_installed()
    {
        var reg = new FakeRegistry();
        var backup = NewBackupPath();

        var exception = Record.Exception(() => Assoc.Uninstall(reg, backup));

        Assert.Null(exception);
        Assert.False(reg.KeyExists(Assoc.ProgIdKey()));
        Assert.False(File.Exists(backup));
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
}

/// <summary>
/// 内存版注册表：路径/值名大小写不敏感，支持默认值（null 值名）、键树删除与存在性判断。
/// </summary>
internal sealed class FakeRegistry : IAssocRegistry
{
    private const string DefaultValueName = "";

    private readonly Dictionary<string, Dictionary<string, string>> _keys =
        new(StringComparer.OrdinalIgnoreCase);

    public string? GetValue(string keyPath, string? valueName)
        => _keys.TryGetValue(keyPath, out var values)
            && values.TryGetValue(NormalizeName(valueName), out var value)
            ? value
            : null;

    public void SetValue(string keyPath, string? valueName, string value)
    {
        if (!_keys.TryGetValue(keyPath, out var values))
        {
            values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            _keys[keyPath] = values;
        }

        values[NormalizeName(valueName)] = value;
    }

    public void DeleteKey(string keyPath)
    {
        var prefix = keyPath + "\\";
        var targets = _keys.Keys
            .Where(path => string.Equals(path, keyPath, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .ToList();
        foreach (var target in targets)
        {
            _keys.Remove(target);
        }
    }

    public void DeleteValue(string keyPath, string? valueName)
    {
        if (_keys.TryGetValue(keyPath, out var values))
        {
            values.Remove(NormalizeName(valueName));
        }
    }

    public bool KeyExists(string keyPath) => _keys.ContainsKey(keyPath);

    private static string NormalizeName(string? valueName) => valueName ?? DefaultValueName;
}
