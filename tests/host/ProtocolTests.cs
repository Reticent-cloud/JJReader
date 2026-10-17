using System.Text.Json;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Protocol：宿主→前端消息构造 + 前端→宿主消息解析（唯一协议定义处的契约测试）。
/// 用例锁定 spec §4.4 的消息契约：<see cref="Protocol"/> 的 KnownTypes 收录 21 个可解析 type
/// （spec 原有 14 条 + 新增 dirListing / shellReady / recent / reload / openRecent / openTreeFile / openAbout 等），
/// 另有宿主→前端的 notice / settings 共 23 个契约 type（这两个不参与 inbound 解析）。
/// </summary>
public class ProtocolTests
{
    // ---------------- 宿主 → 前端 ----------------

    [Fact]
    public void Load_message_roundtrips_through_json()
    {
        var json = Protocol.Load(@"C:\a.md", "k1", "https://md.local/", "# hi", new AppSettings(), 0.5);

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("load", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("https://md.local/", doc.RootElement.GetProperty("payload").GetProperty("baseUrl").GetString());
    }

    [Fact]
    public void Load_payload_contains_path_key_markdown_settings_and_position()
    {
        var settings = new AppSettings(Theme: "dark", FontSize: 20, UiStyle: "whale");
        var json = Protocol.Load(@"C:\笔记 目录\a.md", "k1", "https://md.local/", "# 标题", settings, 0.42);

        using var doc = JsonDocument.Parse(json);
        var payload = doc.RootElement.GetProperty("payload");
        Assert.Equal(@"C:\笔记 目录\a.md", payload.GetProperty("path").GetString());
        Assert.Equal("k1", payload.GetProperty("key").GetString());
        Assert.Equal("# 标题", payload.GetProperty("markdown").GetString());
        Assert.Equal(0.42, payload.GetProperty("position").GetDouble());
        // AppSettings 按 camelCase 序列化，与持久化格式一致（前端按 settings.fontSize 等读取）
        Assert.Equal("dark", payload.GetProperty("settings").GetProperty("theme").GetString());
        Assert.Equal(20, payload.GetProperty("settings").GetProperty("fontSize").GetInt32());
        Assert.Equal("whale", payload.GetProperty("settings").GetProperty("uiStyle").GetString());
    }

    [Fact]
    public void Load_null_position_serializes_as_json_null()
    {
        var json = Protocol.Load(@"C:\a.md", "k", "https://md.local/", string.Empty, new AppSettings(), null);

        using var doc = JsonDocument.Parse(json);
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("payload").GetProperty("position").ValueKind);
    }

    [Fact]
    public void Load_rejects_missing_arguments()
    {
        Assert.Throws<ArgumentException>(() => Protocol.Load(" ", "k", "https://md.local/", string.Empty, new AppSettings(), null));
        Assert.Throws<ArgumentException>(() => Protocol.Load(@"C:\a.md", " ", "https://md.local/", string.Empty, new AppSettings(), null));
        Assert.Throws<ArgumentException>(() => Protocol.Load(@"C:\a.md", "k", " ", string.Empty, new AppSettings(), null));
        Assert.Throws<ArgumentNullException>(() => Protocol.Load(@"C:\a.md", "k", "https://md.local/", null!, new AppSettings(), null));
        Assert.Throws<ArgumentNullException>(() => Protocol.Load(@"C:\a.md", "k", "https://md.local/", string.Empty, null!, null));
    }

    [Fact]
    public void Recent_lists_items_with_path_name_dir_and_openedAt()
    {
        var json = Protocol.Recent(new[]
        {
            (Path: @"C:\notes\a.md", Name: "a.md", Dir: @"C:\notes", OpenedAt: "2026-10-17T09:12:00Z"),
            (Path: @"D:\b.md", Name: "b.md", Dir: @"D:\", OpenedAt: "2026-10-16T08:00:00Z"),
        });

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("recent", doc.RootElement.GetProperty("type").GetString());
        var items = doc.RootElement.GetProperty("payload").GetProperty("items");
        Assert.Equal(2, items.GetArrayLength());

        var first = items[0];
        Assert.Equal(@"C:\notes\a.md", first.GetProperty("path").GetString());
        Assert.Equal("a.md", first.GetProperty("name").GetString());
        Assert.Equal(@"C:\notes", first.GetProperty("dir").GetString());
        Assert.Equal("2026-10-17T09:12:00Z", first.GetProperty("openedAt").GetString());
    }

    [Fact]
    public void Recent_caps_items_at_twenty()
    {
        var items = Enumerable.Range(0, 25)
            .Select(index => (Path: $@"C:\{index}.md", Name: $"{index}.md", Dir: @"C:\", OpenedAt: string.Empty))
            .ToArray();

        using var doc = JsonDocument.Parse(Protocol.Recent(items));
        Assert.Equal(20, doc.RootElement.GetProperty("payload").GetProperty("items").GetArrayLength());
    }

    [Fact]
    public void Recent_rejects_null_items()
    {
        Assert.Throws<ArgumentNullException>(() => Protocol.Recent(null!));
    }

    [Fact]
    public void DirListing_serializes_entries()
    {
        // 两参数重载已标 [Obsolete]（仅供 brief 兼容/测试）：这里显式使用以锁住兼容行为。
#pragma warning disable CS0618
        var json = Protocol.DirListing(@"C:\notes", new[] { ("a.md", false, "a.md"), ("sub", true, "sub") });
#pragma warning restore CS0618

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("dirListing", doc.RootElement.GetProperty("type").GetString());

        var payload = doc.RootElement.GetProperty("payload");
        Assert.Equal(@"C:\notes", payload.GetProperty("root").GetString());
        Assert.Equal(string.Empty, payload.GetProperty("path").GetString());

        var entries = payload.GetProperty("entries");
        Assert.Equal(2, entries.GetArrayLength());
        Assert.Equal("a.md", entries[0].GetProperty("name").GetString());
        Assert.False(entries[0].GetProperty("isDir").GetBoolean());
        Assert.Equal("a.md", entries[0].GetProperty("relPath").GetString());
        Assert.Equal("sub", entries[1].GetProperty("name").GetString());
        Assert.True(entries[1].GetProperty("isDir").GetBoolean());
        Assert.Equal("sub", entries[1].GetProperty("relPath").GetString());
    }

    [Fact]
    public void DirListing_carries_browse_root_and_relative_path()
    {
        var json = Protocol.DirListing(@"C:\笔记 目录", "子目录", new[] { ("a.md", false, "子目录/a.md") });

        using var doc = JsonDocument.Parse(json);
        var payload = doc.RootElement.GetProperty("payload");
        Assert.Equal(@"C:\笔记 目录", payload.GetProperty("root").GetString());
        Assert.Equal("子目录", payload.GetProperty("path").GetString());
        Assert.Equal("子目录/a.md", payload.GetProperty("entries")[0].GetProperty("relPath").GetString());
    }

    [Fact]
    public void DirListing_rejects_missing_root_and_null_entries()
    {
        var empty = Array.Empty<(string, bool, string)>();

#pragma warning disable CS0618 // 两参数重载仅供 brief 兼容，仍要验证其参数校验
        Assert.Throws<ArgumentException>(() => Protocol.DirListing(" ", empty));
#pragma warning restore CS0618
        Assert.Throws<ArgumentException>(() => Protocol.DirListing(@"C:\notes", " ", empty));
        Assert.Throws<ArgumentNullException>(() => Protocol.DirListing(@"C:\notes", null!, empty));
        Assert.Throws<ArgumentNullException>(() => Protocol.DirListing(@"C:\notes", string.Empty, null!));
    }

    [Fact]
    public void Toast_and_assocState_have_fixed_payload_shape()
    {
        using var toast = JsonDocument.Parse(Protocol.Toast("提示"));
        Assert.Equal("toast", toast.RootElement.GetProperty("type").GetString());
        Assert.Equal("提示", toast.RootElement.GetProperty("payload").GetProperty("text").GetString());
        Assert.Equal("info", toast.RootElement.GetProperty("payload").GetProperty("level").GetString());

        using var assoc = JsonDocument.Parse(Protocol.AssocState(registered: true, isDefault: false));
        Assert.Equal("assocState", assoc.RootElement.GetProperty("type").GetString());
        Assert.True(assoc.RootElement.GetProperty("payload").GetProperty("registered").GetBoolean());
        Assert.False(assoc.RootElement.GetProperty("payload").GetProperty("isDefault").GetBoolean());
    }

    // ---------------- 前端 → 宿主 ----------------

    [Fact]
    public void ParseInbound_savePosition_and_unknown_type()
    {
        var m = Protocol.ParseInbound("""{"type":"savePosition","payload":{"key":"k","ratio":0.4}}""");
        Assert.Equal("savePosition", m.Type);
        Assert.Equal(0.4, m.Ratio);

        Assert.Throws<FormatException>(() => Protocol.ParseInbound("""{"type":"bogus"}"""));
    }

    [Fact]
    public void ParseInbound_savePosition_carries_key_and_ratio()
    {
        var m = Protocol.ParseInbound("""{"type":"savePosition","payload":{"key":"sha1-abc","ratio":0.75}}""");

        Assert.Equal("savePosition", m.Type);
        Assert.Equal("sha1-abc", m.Key);
        Assert.Equal(0.75, m.Ratio);
    }

    [Fact]
    public void ParseInbound_shellReady_and_renderDone()
    {
        var ready = Protocol.ParseInbound("""{"type":"shellReady"}""");
        Assert.Equal("shellReady", ready.Type);

        var done = Protocol.ParseInbound(
            """{"type":"renderDone","payload":{"path":"C:\\a.md","elapsedMs":123.5,"tocCount":4,"bytes":2048}}""");
        Assert.Equal("renderDone", done.Type);
        Assert.Equal(@"C:\a.md", done.Path);
        Assert.Equal(123.5, done.ElapsedMs);
        Assert.Equal(4, done.TocCount);
        Assert.Equal(2048, done.Bytes);
    }

    [Fact]
    public void ParseInbound_renderDone_without_payload_uses_zero_defaults()
    {
        var done = Protocol.ParseInbound("""{"type":"renderDone"}""");

        Assert.Equal("renderDone", done.Type);
        Assert.Null(done.Path);
        Assert.Equal(0, done.ElapsedMs);
        Assert.Equal(0, done.TocCount);
        Assert.Equal(0, done.Bytes);
    }

    [Fact]
    public void ParseInbound_reload_has_no_extra_fields()
    {
        var reload = Protocol.ParseInbound("""{"type":"reload"}""");

        Assert.Equal("reload", reload.Type);
        Assert.Null(reload.Key);
        Assert.Null(reload.RelPath);
        Assert.Null(reload.PatchJson);
    }

    [Fact]
    public void ParseInbound_extracts_fields_for_later_tasks()
    {
        var open = Protocol.ParseInbound("""{"type":"openFile","payload":{"relPath":"..\\b.md"}}""");
        Assert.Equal(@"..\b.md", open.RelPath);

        var openRecent = Protocol.ParseInbound("""{"type":"openRecent","payload":{"path":"C:\\notes\\a.md"}}""");
        Assert.Equal(@"C:\notes\a.md", openRecent.Path);

        var openTreeFile = Protocol.ParseInbound("""{"type":"openTreeFile","payload":{"path":"C:\\notes\\sub\\a.md"}}""");
        Assert.Equal(@"C:\notes\sub\a.md", openTreeFile.Path);

        var list = Protocol.ParseInbound("""{"type":"listDir","payload":{"path":"C:\\notes"}}""");
        Assert.Equal(@"C:\notes", list.Path);

        var show = Protocol.ParseInbound("""{"type":"showInFolder","payload":{"path":"C:\\notes\\a.md"}}""");
        Assert.Equal(@"C:\notes\a.md", show.Path);

        var pdf = Protocol.ParseInbound("""{"type":"exportPdf","payload":{"suggestedName":"a.pdf"}}""");
        Assert.Equal("a.pdf", pdf.SuggestedName);

        // patch 保留原始 JSON 文本，T10 合并设置时不需要重新序列化
        var saveSettings = Protocol.ParseInbound("""{"type":"saveSettings","payload":{"patch":{"fontSize":18,"theme":"dark"}}}""");
        Assert.Equal("""{"fontSize":18,"theme":"dark"}""", saveSettings.PatchJson);

        // 空 payload 或完全省略 payload 的合法消息：解析出来但不含附加字段
        var pickFile = Protocol.ParseInbound("""{"type":"pickFile"}""");
        Assert.Equal("pickFile", pickFile.Type);
        var readyToPrint = Protocol.ParseInbound("""{"type":"readyToPrint","payload":{}}""");
        Assert.Equal("readyToPrint", readyToPrint.Type);
    }

    [Theory]
    [InlineData("load")]
    [InlineData("toast")]
    [InlineData("assocState")]
    [InlineData("dirListing")]
    [InlineData("recent")]
    [InlineData("reload")]
    [InlineData("openFile")]
    [InlineData("openRecent")]
    [InlineData("openTreeFile")]
    [InlineData("pickFile")]
    [InlineData("pickFolder")]
    [InlineData("listDir")]
    [InlineData("savePosition")]
    [InlineData("saveSettings")]
    [InlineData("exportPdf")]
    [InlineData("readyToPrint")]
    [InlineData("showInFolder")]
    [InlineData("openDefaultApps")]
    [InlineData("openAbout")]
    [InlineData("renderDone")]
    [InlineData("shellReady")]
    public void ParseInbound_recognizes_every_contract_type(string type)
    {
        var message = Protocol.ParseInbound($$"""{"type":"{{type}}"}""");

        Assert.Equal(type, message.Type);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"payload":{}}""")]
    [InlineData("""{"type":123}""")]
    [InlineData("""{"type":""}""")]
    [InlineData("""{"type":"savePosition","payload":{"ratio":"high"}}""")]
    [InlineData("""{"type":"renderDone","payload":{"elapsedMs":true}}""")]
    [InlineData("""{"type":"openFile","payload":{"relPath":42}}""")]
    public void ParseInbound_rejects_malformed_messages(string json)
    {
        Assert.Throws<FormatException>(() => Protocol.ParseInbound(json));
    }

    [Fact]
    public void ParseInbound_rejects_null_or_empty_input()
    {
        Assert.Throws<FormatException>(() => Protocol.ParseInbound(null!));
        Assert.Throws<FormatException>(() => Protocol.ParseInbound(string.Empty));
        Assert.Throws<FormatException>(() => Protocol.ParseInbound("   "));
    }
}
