using System.Text.Json;

namespace JingjingReader;

/// <summary>
/// <c>saveSettings{patch}</c> 的合并逻辑（纯函数，无 I/O）。
/// 前端只上报变化字段；这里把类型匹配的已知字段合并进 <see cref="AppSettings"/>，
/// 未知字段、类型不符的字段（含 null）一律忽略——坏 patch 不能把设置写坏。
/// 抽成纯函数便于单测：MainWindow 依赖 WPF/WebView2，无法在 xUnit 里直接构造。
/// </summary>
public static class SettingsPatch
{
    /// <summary>把 <paramref name="patchJson"/> 合并到 <paramref name="current"/>；空/坏 JSON 原样返回 current。</summary>
    public static AppSettings Apply(AppSettings current, string? patchJson)
    {
        ArgumentNullException.ThrowIfNull(current);

        if (string.IsNullOrWhiteSpace(patchJson))
        {
            return current;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(patchJson);
        }
        catch (JsonException)
        {
            return current;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return current;
            }

            var merged = current;
            if (TryString(root, "theme", out var theme))
            {
                merged = merged with { Theme = theme };
            }

            if (TryInt(root, "fontSize", out var fontSize))
            {
                merged = merged with { FontSize = fontSize };
            }

            if (TryDouble(root, "lineHeight", out var lineHeight))
            {
                merged = merged with { LineHeight = lineHeight };
            }

            if (TryInt(root, "contentWidth", out var contentWidth))
            {
                merged = merged with { ContentWidth = contentWidth };
            }

            if (TryString(root, "cjkFont", out var cjkFont))
            {
                merged = merged with { CjkFont = cjkFont };
            }

            if (TryString(root, "monoFont", out var monoFont))
            {
                merged = merged with { MonoFont = monoFont };
            }

            if (TryBool(root, "tocVisible", out var tocVisible))
            {
                merged = merged with { TocVisible = tocVisible };
            }

            if (TryInt(root, "tocWidth", out var tocWidth))
            {
                merged = merged with { TocWidth = tocWidth };
            }

            return merged;
        }
    }

    private static bool TryString(JsonElement root, string name, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = element.GetString() ?? string.Empty;
        return true;
    }

    private static bool TryInt(JsonElement root, string name, out int value)
    {
        value = 0;
        return root.TryGetProperty(name, out var element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value);
    }

    private static bool TryDouble(JsonElement root, string name, out double value)
    {
        value = 0d;
        return root.TryGetProperty(name, out var element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetDouble(out value);
    }

    private static bool TryBool(JsonElement root, string name, out bool value)
    {
        value = false;
        if (!root.TryGetProperty(name, out var element)
            || element.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return false;
        }

        value = element.GetBoolean();
        return true;
    }
}
