using System.IO;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>Store：设置/最近/位置三个 JSON 文件的真实读写（临时目录，无 mock）。</summary>
public class StoreTests
{
    private static string TestDir() => TestHelpers.TestDir();

    [Fact]
    public void Settings_roundtrip_and_defaults()
    {
        var dir = TestDir();
        var store = new Store(dir);

        // 缺文件时给默认值（默认值即 Produces 契约）
        var defaults = store.LoadSettings();
        Assert.Equal(new AppSettings(), defaults);
        Assert.Equal("system", defaults.Theme);
        Assert.Equal("default", defaults.Palette);

        store.SaveSettings(defaults with
        {
            Theme = "dark",
            FontSize = 20,
            Window = new WindowGeometry(X: 5, Y: 6, W: 1200, H: 900, Max: true),
        });

        var reloaded = new Store(dir).LoadSettings();
        Assert.Equal("dark", reloaded.Theme);
        Assert.Equal(20, reloaded.FontSize);
        Assert.Equal(1.7, reloaded.LineHeight);
        Assert.Equal(new WindowGeometry(5, 6, 1200, 900, true), reloaded.Window);
    }

    [Fact]
    public void Corrupt_json_is_backed_up_and_reset()
    {
        var dir = TestDir();
        File.WriteAllText(Path.Combine(dir, "settings.json"), "{broken");

        var store = new Store(dir);
        Assert.Equal("system", store.LoadSettings().Theme);

        var backups = Directory.GetFiles(dir, "settings.json.bak-*");
        Assert.Single(backups);
        Assert.Equal("{broken", File.ReadAllText(backups[0]));

        // 再次读取仍给默认值，且不会重复备份
        Assert.Equal(16, new Store(dir).LoadSettings().FontSize);
        Assert.Single(Directory.GetFiles(dir, "settings.json.bak-*"));
    }

    [Fact]
    public void Corrupt_recent_is_backed_up_and_reset()
    {
        var dir = TestDir();
        File.WriteAllText(Path.Combine(dir, "recent.json"), "[oops");

        Assert.Empty(new Store(dir).LoadRecent());
        Assert.Single(Directory.GetFiles(dir, "recent.json.bak-*"));
    }

    [Fact]
    public void Corrupt_positions_is_backed_up_and_reset()
    {
        var dir = TestDir();
        File.WriteAllText(Path.Combine(dir, "positions.json"), """{"not":"an array"}""");

        var store = new Store(dir);
        Assert.Empty(store.LoadPositions());
        Assert.Null(store.FindPosition("anything"));
        Assert.Single(Directory.GetFiles(dir, "positions.json.bak-*"));
    }

    [Fact]
    public void Recent_dedupes_caps_at_20()
    {
        var dir = TestDir();
        var store = new Store(dir);
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        for (var i = 0; i < 21; i++)
        {
            store.PushRecent($@"C:\notes\f{i}.md", 1000 + i, now.AddMinutes(i));
        }

        var capped = new Store(dir).LoadRecent(); // 新实例读盘，验证真实持久化
        Assert.Equal(20, capped.Count);
        Assert.Equal(@"C:\notes\f20.md", capped[0].Path);
        Assert.Equal(@"C:\notes\f1.md", capped[^1].Path); // 最旧的 f0 被淘汰
        Assert.Contains(capped, e => e.Path == @"C:\notes\f20.md" && e.Size == 1020);

        // 同路径去重（大小写不敏感）后置顶
        store.PushRecent(@"C:\NOTES\F5.MD", 9999, now.AddHours(1));
        var deduped = new Store(dir).LoadRecent();
        Assert.Equal(20, deduped.Count);
        Assert.Equal(@"C:\NOTES\F5.MD", deduped[0].Path);
        Assert.Equal(9999, deduped[0].Size);
        Assert.Single(deduped, e => string.Equals(e.Path, @"C:\notes\f5.md", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Position_clamps_ratio_and_evicts_lru()
    {
        var dir = TestDir();
        var store = new Store(dir);
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        // ratio 夹紧到 [0,1]
        store.SavePosition("clamp-hi", @"C:\n\hi.md", 1.7, now.AddSeconds(-2));
        store.SavePosition("clamp-lo", @"C:\n\lo.md", -0.3, now.AddSeconds(-1));
        Assert.Equal(1.0, store.FindPosition("clamp-hi"));
        Assert.Equal(0.0, store.FindPosition("clamp-lo"));

        // 写入 501 条（按时间递增），超过 500 上限后最旧的被淘汰
        for (var i = 0; i < 501; i++)
        {
            store.SavePosition($"key{i}", $@"C:\n\f{i}.md", 0.5, now.AddSeconds(i));
        }

        var all = store.LoadPositions();
        Assert.Equal(500, all.Count);
        Assert.Null(store.FindPosition("key0")); // 最旧的被淘汰
        Assert.Equal("key500", all[0].Key); // 最新的排最前
        Assert.Equal("key1", all[^1].Key);
        Assert.Equal(0.5, store.FindPosition("key500"));
    }

    [Fact]
    public void SavePosition_replaces_same_key_and_orders_newest_first()
    {
        var dir = TestDir();
        var store = new Store(dir);
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        store.SavePosition("a", @"C:\n\a.md", 0.1, now);
        store.SavePosition("b", @"C:\n\b.md", 0.2, now.AddSeconds(1));
        store.SavePosition("a", @"C:\n\a.md", 0.9, now.AddSeconds(2));

        var all = new Store(dir).LoadPositions(); // 新实例：验证落盘
        Assert.Equal(2, all.Count); // 同 key 去重，不追加
        Assert.Equal("a", all[0].Key);
        Assert.Equal(0.9, all[0].Ratio);
        Assert.Equal("b", all[1].Key);
        Assert.Equal(0.9, store.FindPosition("a"));
        Assert.Null(store.FindPosition("missing"));
    }

    [Fact]
    public void ComputeKey_stable_and_case_insensitive_path()
    {
        var mtime = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var a = Store.ComputeKey(@"d:\Notes\A.md", 10, mtime);
        var b = Store.ComputeKey(@"D:\notes\a.md", 10, mtime);

        Assert.Equal(a, b);
        Assert.Equal(a, Store.ComputeKey(@"d:\Notes\A.md", 10, mtime)); // 同输入稳定
        Assert.NotEqual(a, Store.ComputeKey(@"d:\Notes\B.md", 10, mtime)); // 路径参与
        Assert.NotEqual(a, Store.ComputeKey(@"d:\Notes\A.md", 11, mtime)); // 大小参与
        Assert.NotEqual(a, Store.ComputeKey(@"d:\Notes\A.md", 10, mtime.AddTicks(1))); // 修改时间参与
        Assert.False(string.IsNullOrWhiteSpace(a));
    }

    [Fact]
    public void SaveSettings_writes_camel_case_json_atomically()
    {
        var dir = TestDir();
        var store = new Store(dir);
        store.SaveSettings(new AppSettings(Theme: "dark"));

        var target = Path.Combine(dir, "settings.json");
        var json = File.ReadAllText(target);
        Assert.Contains("\"theme\": \"dark\"", json); // camelCase（spec §6.3）
        Assert.Contains("\"lineHeight\": 1.7", json);
        Assert.Contains("\"tocWidth\": 240", json);
        Assert.Contains("\"window\": null", json);
        Assert.Contains("\"monoFont\": \"consolas\"", json);
        Assert.Contains("\"palette\": \"default\"", json);
        Assert.DoesNotContain("\"uiStyle\"", json); // whale 主题已删除：不再写界面风格字段
        Assert.False(File.Exists(target + ".tmp")); // 原子写完成后不留临时文件
    }

    [Fact]
    public void Settings_roundtrip_includes_mono_font()
    {
        var dir = TestDir();
        var store = new Store(dir);

        // 默认值来自 record 位置参数默认值（spec §5.5 / §6.3：代码字体默认 consolas）
        Assert.Equal("consolas", store.LoadSettings().MonoFont);

        store.SaveSettings(new AppSettings(MonoFont: "Cascadia Mono"));
        Assert.Equal("Cascadia Mono", new Store(dir).LoadSettings().MonoFont);
        Assert.Equal("system", new Store(dir).LoadSettings().CjkFont); // 相邻字体字段不受影响
    }

    [Fact]
    public void Settings_roundtrip_includes_palette()
    {
        var dir = TestDir();
        var store = new Store(dir);

        // 默认配色 = 中性「默认」（浅色正文纯白），来自 record 位置参数默认值。
        Assert.Equal("default", store.LoadSettings().Palette);

        store.SaveSettings(new AppSettings(Palette: "blue"));
        Assert.Equal("blue", new Store(dir).LoadSettings().Palette);

        store.SaveSettings(new AppSettings());
        Assert.Equal("default", new Store(dir).LoadSettings().Palette);
    }

    [Fact]
    public void LoadSettings_old_file_without_palette_defaults_default()
    {
        // 兼容旧 settings.json：升级前写出的文件没有 palette 字段，读取时必须取默认值 default（白色）。
        var dir = TestDir();
        File.WriteAllText(
            Path.Combine(dir, "settings.json"),
            """
            {
              "theme": "light",
              "fontSize": 17,
              "monoFont": "Cascadia Mono"
            }
            """);

        var loaded = new Store(dir).LoadSettings();

        Assert.Equal("default", loaded.Palette);
        Assert.Equal("light", loaded.Theme);
        Assert.Equal(17, loaded.FontSize);
    }

    [Fact]
    public void LoadSettings_ignores_legacy_ui_style_field()
    {
        // 兼容旧 settings.json：whale 主题删除后，文件里遗留的 uiStyle 是未知字段，必须被忽略且不影响读取。
        var dir = TestDir();
        var target = Path.Combine(dir, "settings.json");
        File.WriteAllText(
            target,
            """
            {
              "theme": "dark",
              "fontSize": 18,
              "uiStyle": "whale",
              "monoFont": "Cascadia Mono"
            }
            """);

        var reloaded = new Store(dir).LoadSettings();

        Assert.Equal("dark", reloaded.Theme);
        Assert.Equal(18, reloaded.FontSize);
        Assert.Equal("Cascadia Mono", reloaded.MonoFont);
        // 未知字段不触发损坏备份：原文件保留且没有被改名。
        Assert.True(File.Exists(target));
    }

    [Fact]
    public void SaveSettings_failure_keeps_old_file_and_cleans_tmp()
    {
        // 原子写失败路径（测试评审 must-fix）：目标文件被独占打开时 File.Move 必须失败，
        // 且失败后 ①目标字节不变 ②重新读取仍是旧值 ③不留下 settings.json.tmp 半成品。
        var dir = TestDir();
        var store = new Store(dir);
        store.SaveSettings(new AppSettings(Theme: "dark", FontSize: 20));

        var target = Path.Combine(dir, "settings.json");
        var before = File.ReadAllBytes(target);

        using (var exclusive = new FileStream(
                   target,
                   FileMode.Open,
                   FileAccess.ReadWrite,
                   FileShare.None))
        {
            // File.Move 在目标被独占打开时可能报 IOException（共享冲突）或 UnauthorizedAccessException
            // （Windows 路径语义），两者都算失败路径；关键是必须抛异常、不能静默覆盖。
            var exception = Record.Exception(() => store.SaveSettings(new AppSettings(Theme: "light", FontSize: 14)));
            Assert.NotNull(exception);
            Assert.True(
                exception is IOException or UnauthorizedAccessException,
                $"期望 IO/UnauthorizedAccess 异常，实际：{exception.GetType().Name}: {exception.Message}");
        }

        Assert.Equal(before, File.ReadAllBytes(target));
        var reloaded = new Store(dir).LoadSettings();
        Assert.Equal("dark", reloaded.Theme);
        Assert.Equal(20, reloaded.FontSize);
        Assert.False(File.Exists(target + ".tmp"), "写入失败后必须清理 .tmp，不能留下半成品");
    }
}
