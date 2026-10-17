using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// C1（关联收尾）UserChoice：安装只在有效默认不存在时写 Classes 默认值；
/// 卸载识别 UserChoice 仍指向本程序并给出「需重新选择」标志（不删除、不失败）。
/// </summary>
public class AssocUserChoiceTests
{
    private const string ExePath = @"C:\apps\JingjingReader.exe";

    private static string NewBackupPath() => Path.Combine(TestHelpers.TestDir(), "assoc-backup.json");

    [Fact]
    public void Install_does_not_write_classes_default_when_userchoice_points_elsewhere()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "Typora.md");
        var backup = NewBackupPath();

        Assoc.Install(registry, ExePath, backup);

        Assert.Null(registry.GetValue(Assoc.DotMdKey(), null));
        Assert.Equal(string.Empty, registry.GetValue(Assoc.OpenWithProgidsKey(), Assoc.ProgId));
        Assert.False(Assoc.GetState(registry).IsDefault);
    }

    [Fact]
    public void Install_writes_classes_default_when_userchoice_absent()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "   ");
        var backup = NewBackupPath();

        Assoc.Install(registry, ExePath, backup);

        Assert.Equal(Assoc.ProgId, registry.GetValue(Assoc.DotMdKey(), null));
        Assert.True(Assoc.GetState(registry).IsDefault);
    }

    [Fact]
    public void Install_keeps_existing_classes_default_when_userchoice_missing()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        var backup = NewBackupPath();

        Assoc.Install(registry, ExePath, backup);

        Assert.Equal("WorkBuddy.md", registry.GetValue(Assoc.DotMdKey(), null));
    }

    [Fact]
    public void Uninstall_reports_userchoice_needs_reselect_and_leaves_it_untouched()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", Assoc.ProgId);
        registry.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);
        var backup = NewBackupPath();
        Assoc.Install(registry, ExePath, backup);

        var outcome = Assoc.UninstallDetailed(registry, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, outcome.Result);
        Assert.True(outcome.UserChoiceNeedsReselect);
        // UserChoice 受系统保护：卸载不删除也不改写
        Assert.Equal(Assoc.ProgId, registry.GetValue(Assoc.UserChoiceKey(), "ProgId"));
    }

    [Fact]
    public void Uninstall_does_not_warn_when_userchoice_points_elsewhere()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "Typora.md");
        var backup = NewBackupPath();
        Assoc.Install(registry, ExePath, backup);

        var outcome = Assoc.UninstallDetailed(registry, backup);

        Assert.Equal(AssocUninstallResult.RestoredFromBackup, outcome.Result);
        Assert.False(outcome.UserChoiceNeedsReselect);
        // 既有 Uninstall 入口行为不变
        Assert.Equal(AssocUninstallResult.RemovedWithoutBackup, Assoc.Uninstall(new FakeRegistry(), NewBackupPath()));
    }

    [Fact]
    public void Uninstall_with_corrupt_backup_does_not_claim_userchoice_warning()
    {
        var registry = new FakeRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", Assoc.ProgId);
        var backup = NewBackupPath();
        File.WriteAllText(backup, "{ not json");

        var outcome = Assoc.UninstallDetailed(registry, backup);

        Assert.Equal(AssocUninstallResult.BackupCorrupt, outcome.Result);
        Assert.False(outcome.UserChoiceNeedsReselect);
        Assert.Equal(Assoc.ProgId, registry.GetValue(Assoc.UserChoiceKey(), "ProgId"));
    }
}
