using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JingjingReader;

/// <summary>窗口位置与大小（settings.json 的 window 字段）。</summary>
public sealed record WindowGeometry(int X = 100, int Y = 80, int W = 1000, int H = 760, bool Max = false);

/// <summary>阅读偏好，持久化到 settings.json（spec §5.5 / §6.3）。</summary>
public sealed record AppSettings(
    string Theme = "system",
    int FontSize = 16,
    double LineHeight = 1.7,
    int ContentWidth = 780,
    string CjkFont = "system",
    bool TocVisible = true,
    int TocWidth = 240,
    WindowGeometry? Window = null,
    // T2 Ruling：spec §5.5/§6.3 的 monoFont（代码字体）补在 record 末尾，位置参数带默认值保持向后兼容。
    string MonoFont = "consolas",
    // 配色维度（palette）：default = 中性灰蓝 / blue = 鲸鱼蓝（默认）；同样补在末尾，旧 settings.json 缺字段时取默认值。
    string Palette = "blue");

/// <summary>最近文件条目，持久化到 recent.json（最多 20 条，最新在前）。</summary>
public sealed record RecentEntry(string Path, string OpenedAt, long Size);

/// <summary>阅读位置条目，持久化到 positions.json（最多 500 条，最新在前）。</summary>
public sealed record PositionEntry(string Key, string Path, double Ratio, string UpdatedAt);

/// <summary>
/// 数据目录下三个 JSON 文件的读写：settings.json、recent.json、positions.json。
/// 写入走「写 .tmp → File.Move 覆盖」的原子替换；读取失败（损坏 / 不可读）时先把原文件
/// 改名为 &lt;name&gt;.json.bak-&lt;UTC yyyyMMddHHmmss&gt; 备份，再返回默认值。
/// </summary>
public sealed class Store
{
    /// <summary>最近文件条数上限（Global Constraints）。</summary>
    private const int MaxRecent = 20;

    /// <summary>位置记忆条数上限（Global Constraints）。</summary>
    private const int MaxPositions = 500;

    private const string SettingsFileName = "settings.json";
    private const string RecentFileName = "recent.json";
    private const string PositionsFileName = "positions.json";
    private const string BackupStampFormat = "yyyyMMddHHmmss";

    /// <summary>落盘时间戳统一为 UTC ISO 8601 秒精度（spec §6.3 示例形如 2026-10-17T09:12:00Z）。</summary>
    private const string TimeFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public Store(string dataDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDir);
        DataDir = dataDir;
    }

    public string DataDir { get; }

    /// <summary>读设置；缺文件或文件损坏时返回默认设置。</summary>
    public AppSettings LoadSettings()
        => LoadOr(SettingsFileName, static () => new AppSettings());

    /// <summary>原子写 settings.json。</summary>
    public void SaveSettings(AppSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        Save(SettingsFileName, settings);
    }

    /// <summary>读最近文件列表（最新在前，最多 20 条）；缺文件或损坏时返回空列表。</summary>
    public IReadOnlyList<RecentEntry> LoadRecent()
        => LoadOr(RecentFileName, static () => new List<RecentEntry?>())
            .OfType<RecentEntry>()
            .Take(MaxRecent)
            .ToList();

    /// <summary>同路径（大小写不敏感）去重后置顶，最多保留 20 条。</summary>
    public void PushRecent(string path, long size, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var entries = LoadRecent().ToList();
        entries.RemoveAll(e => string.Equals(e.Path, path, StringComparison.OrdinalIgnoreCase));
        entries.Insert(0, new RecentEntry(path, FormatTime(now), size));
        Save(RecentFileName, entries.Take(MaxRecent).ToList());
    }

    /// <summary>读位置列表（按 UpdatedAt 倒序，最多 500 条）；缺文件或损坏时返回空列表。</summary>
    public IReadOnlyList<PositionEntry> LoadPositions()
        => LoadOr(PositionsFileName, static () => new List<PositionEntry?>())
            .OfType<PositionEntry>()
            .OrderByDescending(e => ParseTime(e.UpdatedAt))
            .Take(MaxPositions)
            .ToList();

    /// <summary>ratio 限制到 [0,1]；同 key 旧记录先移除再置顶；超过 500 条淘汰最旧的。</summary>
    public void SavePosition(string key, string path, double ratio, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        var clamped = double.IsNaN(ratio) ? 0d : Math.Clamp(ratio, 0d, 1d);
        var entries = LoadPositions()
            .Where(e => !string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase))
            .ToList();
        entries.Insert(0, new PositionEntry(key, path, clamped, FormatTime(now)));
        Save(PositionsFileName, entries.Take(MaxPositions).ToList());
    }

    /// <summary>按 key 查上次阅读位置；没有记录时返回 null。</summary>
    public double? FindPosition(string key)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        foreach (var entry in LoadPositions())
        {
            if (string.Equals(entry.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                return entry.Ratio;
            }
        }

        return null;
    }

    /// <summary>位置键 = sha1(小写路径|文件大小|最后修改时间 UTC ticks)，十六进制小写。</summary>
    public static string ComputeKey(string normalizedPath, long size, DateTime lastWriteUtc)
    {
        ArgumentNullException.ThrowIfNull(normalizedPath);
        var payload = normalizedPath.ToLowerInvariant()
            + "|" + size.ToString(CultureInfo.InvariantCulture)
            + "|" + lastWriteUtc.Ticks.ToString(CultureInfo.InvariantCulture);
        var hash = SHA1.HashData(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// 原子写：先写 &lt;name&gt;.json.tmp，再用 File.Move 覆盖目标文件。
    /// 失败时清理 .tmp（目标被占用 / 磁盘满 / 权限不足）：磁盘上不留下「看起来像新设置」的半成品，
    /// 原目标文件保持不变，异常照常向上抛给调用方记录。
    /// </summary>
    private void Save<T>(string fileName, T value)
    {
        var target = Path.Combine(DataDir, fileName);
        var tmp = target + ".tmp";
        Directory.CreateDirectory(DataDir);
        try
        {
            File.WriteAllText(tmp, JsonSerializer.Serialize(value, JsonOptions), Utf8NoBom);
            File.Move(tmp, target, overwrite: true);
        }
        finally
        {
            try
            {
                if (File.Exists(tmp))
                {
                    File.Delete(tmp);
                }
            }
            catch (Exception)
            {
                // 清理失败不能掩盖 Save 的原始异常；残留 .tmp 不影响读取（下次写入会覆盖）。
            }
        }
    }

    /// <summary>读 JSON；文件不存在返回默认值，读取/解析失败则备份坏文件后返回默认值。</summary>
    private T LoadOr<T>(string fileName, Func<T> fallback)
        where T : class
    {
        var target = Path.Combine(DataDir, fileName);
        if (!File.Exists(target))
        {
            return fallback();
        }

        try
        {
            var json = File.ReadAllText(target);
            return JsonSerializer.Deserialize<T>(json, JsonOptions) ?? fallback();
        }
        catch (Exception)
        {
            // 损坏或不读：先备份原文件再回退默认值（不静默丢弃损坏内容）。
            BackupCorrupt(target);
            return fallback();
        }
    }

    /// <summary>把坏文件改名为 &lt;name&gt;.json.bak-&lt;UTC yyyyMMddHHmmss&gt;。</summary>
    private static void BackupCorrupt(string target)
    {
        var stamp = DateTime.UtcNow.ToString(BackupStampFormat, CultureInfo.InvariantCulture);
        try
        {
            File.Move(target, target + ".bak-" + stamp);
        }
        catch (Exception)
        {
            // 改名失败（文件被占用等）不阻断默认值回退：原文件保留，下次读取会再尝试备份。
        }
    }

    private static string FormatTime(DateTimeOffset value)
        => value.ToUniversalTime().ToString(TimeFormat, CultureInfo.InvariantCulture);

    private static DateTimeOffset ParseTime(string value)
        => DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var parsed)
            ? parsed
            : DateTimeOffset.MinValue;
}
