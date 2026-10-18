using System.Text.Json;

namespace JingjingReader;

/// <summary>
/// 前后端 JSON 消息的唯一协议定义处（spec §4.4 的 14 条 + 本计划新增的 dirListing / shellReady / recent / reload / openAbout / openRecent / openTreeFile）。
/// 消息体统一为 <c>{type, payload}</c>：宿主→前端用 <see cref="Load"/> 等构造方法生成 JSON 字符串，
/// 再用 <c>PostWebMessageAsJson</c> 推送；前端→宿主用 <see cref="ParseInbound"/> 解析。
/// </summary>
public static class Protocol
{
    /// <summary>最近文件列表上限（Global Constraints：20 条）。</summary>
    private const int MaxRecent = 20;

    // 消息里的字段名统一 camelCase（与持久化 JSON、前端 JS 习惯一致）。
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>
    /// 契约里的全部消息 type。方向不影响解析容错（方向由调用方分派），
    /// 只有不在契约里的 type 才视为错误——这样「未知 type 抛 FormatException」才有意义。
    /// </summary>
    private static readonly HashSet<string> KnownTypes = new(StringComparer.Ordinal)
    {
        // 宿主 → 前端
        "load",
        "toast",
        "assocState",
        "dirListing",
        "recent",

        // 前端 → 宿主
        "openFile",
        "openRecent",
        "openTreeFile",
        "pickFile",
        "pickFolder",
        "listDir",
        "savePosition",
        "saveSettings",
        "exportPdf",
        "readyToPrint",
        "showInFolder",
        "openDefaultApps",
        "openAbout",
        "renderDone",
        "shellReady",
        "reload",
    };

    /// <summary>构造 <c>load</c>：宿主在收到前端 <c>shellReady</c> 后推送文档内容。</summary>
    public static string Load(
        string path,
        string key,
        string baseUrl,
        string markdown,
        AppSettings settings,
        double? position,
        // 修复波 B-§5.11：附带编码名供前端调试（旧调用方不传时按 utf-8）。
        string encoding = "utf-8")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentException.ThrowIfNullOrWhiteSpace(baseUrl);
        ArgumentNullException.ThrowIfNull(markdown);
        ArgumentNullException.ThrowIfNull(settings);

        return Serialize("load", new { path, key, baseUrl, markdown, settings, position, encoding });
    }

    /// <summary>构造 <c>toast</c>：宿主主动提示（编码异常、二进制文件等）。</summary>
    public static string Toast(string text, string level = "info")
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentException.ThrowIfNullOrWhiteSpace(level);

        return Serialize("toast", new { text, level });
    }

    /// <summary>
    /// 构造 <c>notice</c>（修复波 B-§5.11）：宿主主动的持久提示（编码异常、二进制拒绝、文件打不开）。
    /// <paramref name="persistent"/> 为 true 时前端显示为可关闭的顶部错误条（而不是 3 秒消失的 toast）。
    /// </summary>
    public static string Notice(string text, string level = "warn", bool persistent = true)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentException.ThrowIfNullOrWhiteSpace(level);

        return Serialize("notice", new { text, level, persistent });
    }

    /// <summary>
    /// 构造 <c>settings</c>（修复波 B-前端空白启动）：宿主在 shellReady 后下发已持久化的偏好，
    /// 空白启动页也应用主题/字号（不必等 load）。payload 直接是 AppSettings 的 camelCase 字段。
    /// </summary>
    public static string Settings(AppSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return Serialize("settings", settings);
    }

    /// <summary>构造 <c>assocState</c>：.md 文件关联状态（Task 16 使用）。</summary>
    public static string AssocState(bool registered, bool isDefault)
        => Serialize("assocState", new { registered, isDefault });

    /// <summary>
    /// 构造 <c>recent</c>：最近文件列表（最新在前，最多 20 条；空白启动页与标题栏菜单共用）。
    /// 显示名/目录在宿主侧算好，前端只负责展示（避免前端处理 Windows 路径差异）。
    /// </summary>
    public static string Recent(IEnumerable<(string Path, string Name, string Dir, string OpenedAt)> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var entries = items
            .Take(MaxRecent)
            .Select(item => new { path = item.Path, name = item.Name, dir = item.Dir, openedAt = item.OpenedAt })
            .ToList();
        return Serialize("recent", new { items = entries });
    }

    /// <summary>
    /// 构造 <c>dirListing</c>：浏览根 <paramref name="root"/> 下相对路径 <paramref name="path"/> 目录的直接子项。
    /// <paramref name="path"/> 为空串表示根目录；<c>relPath</c> 也是相对 root（<c>/</c> 分隔）。
    /// 目录在前、名称排序等由 <see cref="DirectoryLister"/> 保证，前端只负责展示。
    /// </summary>
    public static string DirListing(
        string root,
        string path,
        IEnumerable<(string Name, bool IsDir, string RelPath)> entries)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(entries);
        if (path.Length > 0 && string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("path 不能为纯空白；根目录请传空字符串。", nameof(path));
        }

        var items = entries
            .Select(entry => new { name = entry.Name, isDir = entry.IsDir, relPath = entry.RelPath })
            .ToList();
        return Serialize("dirListing", new { root, path, entries = items });
    }

    /// <summary>
    /// brief 兼容重载：只有根列表（<c>path = ""</c>）。
    /// 仅供测试/文档示例兼容（brief 的两参数调用），产品代码请使用三参数重载；保留它只是为了不破坏既有测试。
    /// </summary>
    [Obsolete("测试专用兼容重载（path 固定为空）：产品代码请使用 DirListing(root, path, entries)。")]
    public static string DirListing(
        string root,
        IEnumerable<(string Name, bool IsDir, string RelPath)> entries)
        => DirListing(root, string.Empty, entries);

    /// <summary>
    /// 解析前端发来的消息。未知 type、非 JSON 对象、字段类型不符都抛 <see cref="FormatException"/>，
    /// 由调用方记日志后忽略（坏消息不能中断宿主）。缺省的可选字段使用默认值（0 / null）。
    /// </summary>
    public static InboundMessage ParseInbound(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            throw new FormatException("消息体为空，无法解析。");
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException e)
        {
            throw new FormatException("消息不是合法的 JSON。", e);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new FormatException("消息必须是 JSON 对象。");
            }

            if (!root.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
            {
                throw new FormatException("消息缺少字符串字段 type。");
            }

            var type = typeElement.GetString() ?? string.Empty;
            if (!KnownTypes.Contains(type))
            {
                throw new FormatException($"未知的消息 type：{type}");
            }

            // 没有 payload（pickFile/pickFolder/shellReady/readyToPrint 等空消息）时各字段保持默认值。
            if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind == JsonValueKind.Null)
            {
                return new InboundMessage(type, null, 0, null, null, null, null);
            }

            if (payload.ValueKind != JsonValueKind.Object)
            {
                throw new FormatException("payload 必须是 JSON 对象。");
            }

            // patch 保留原始 JSON 文本：宿主合并设置时不必重新序列化（Task 10 使用）。
            var patchJson = payload.TryGetProperty("patch", out var patch) ? patch.GetRawText() : null;

            return new InboundMessage(
                type,
                OptionalString(payload, "key"),
                OptionalDouble(payload, "ratio"),
                patchJson,
                OptionalString(payload, "relPath"),
                OptionalString(payload, "suggestedName"),
                OptionalString(payload, "path"),
                OptionalDouble(payload, "elapsedMs"),
                OptionalInt(payload, "tocCount"),
                OptionalLong(payload, "bytes"));
        }
    }

    private static string Serialize<T>(string type, T payload)
        => JsonSerializer.Serialize(new { type, payload }, JsonOptions);

    private static string? OptionalString(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element))
        {
            return null;
        }

        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Null => null,
            _ => throw new FormatException($"payload.{name} 必须是字符串。"),
        };
    }

    private static double OptionalDouble(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element))
        {
            return 0d;
        }

        return element.ValueKind == JsonValueKind.Number
            ? element.GetDouble()
            : throw new FormatException($"payload.{name} 必须是数字。");
    }

    private static int OptionalInt(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element))
        {
            return 0;
        }

        return element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var value)
            ? value
            : throw new FormatException($"payload.{name} 必须是 32 位整数。");
    }

    private static long OptionalLong(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var element))
        {
            return 0L;
        }

        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var value)
            ? value
            : throw new FormatException($"payload.{name} 必须是 64 位整数。");
    }
}

/// <summary>
/// 解析后的前端→宿主消息。<see cref="PatchJson"/> 是 <c>payload.patch</c> 的原始 JSON 文本；
/// <see cref="ElapsedMs"/>/<see cref="TocCount"/>/<see cref="Bytes"/> 来自 <c>renderDone</c>，
/// 供 debug 日志与 <c>--verify-render</c> 输出（T5 起 tocCount 是真实标题数）。
/// </summary>
public sealed record InboundMessage(
    string Type,
    string? Key,
    double Ratio,
    string? PatchJson,
    string? RelPath,
    string? SuggestedName,
    string? Path,
    double ElapsedMs = 0,
    int TocCount = 0,
    long Bytes = 0);
