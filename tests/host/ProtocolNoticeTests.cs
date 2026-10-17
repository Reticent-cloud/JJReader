using System.Text.Json;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// 修复波 B 新增的宿主→前端消息：notice（持久错误条）、settings（空白启动偏好），
/// 以及 load 附带的 encoding 调试字段。宿主→前端消息不进入 KnownTypes（那是前端→宿主白名单）。
/// </summary>
public class ProtocolNoticeTests
{
    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    [Fact]
    public void Notice_serializes_text_level_persistent()
    {
        var root = Parse(Protocol.Notice("文件编码可能不是 UTF-8", "warn", persistent: true));

        Assert.Equal("notice", root.GetProperty("type").GetString());
        var payload = root.GetProperty("payload");
        Assert.Equal("文件编码可能不是 UTF-8", payload.GetProperty("text").GetString());
        Assert.Equal("warn", payload.GetProperty("level").GetString());
        Assert.True(payload.GetProperty("persistent").GetBoolean());
    }

    [Fact]
    public void Notice_defaults_to_persistent_warn()
    {
        var payload = Parse(Protocol.Notice("x")).GetProperty("payload");

        Assert.Equal("warn", payload.GetProperty("level").GetString());
        Assert.True(payload.GetProperty("persistent").GetBoolean());
    }

    [Fact]
    public void Settings_serializes_camel_case_app_settings()
    {
        var settings = new AppSettings(Theme: "dark", FontSize: 18, TocVisible: false);

        var root = Parse(Protocol.Settings(settings));

        Assert.Equal("settings", root.GetProperty("type").GetString());
        var payload = root.GetProperty("payload");
        Assert.Equal("dark", payload.GetProperty("theme").GetString());
        Assert.Equal(18, payload.GetProperty("fontSize").GetInt32());
        Assert.False(payload.GetProperty("tocVisible").GetBoolean());
        Assert.Equal(1.7, payload.GetProperty("lineHeight").GetDouble());
    }

    [Fact]
    public void Load_includes_encoding_for_debugging()
    {
        var root = Parse(Protocol.Load("a.md", "k", "https://md.local/", "x", new AppSettings(), null, "gb18030"));

        Assert.Equal("gb18030", root.GetProperty("payload").GetProperty("encoding").GetString());
    }

    [Fact]
    public void Load_defaults_encoding_to_utf8_for_old_callers()
    {
        var root = Parse(Protocol.Load("a.md", "k", "https://md.local/", "x", new AppSettings(), null));

        Assert.Equal("utf-8", root.GetProperty("payload").GetProperty("encoding").GetString());
    }

    [Fact]
    public void Null_settings_are_rejected()
    {
        Assert.Throws<ArgumentNullException>(() => Protocol.Settings(null!));
        Assert.Throws<ArgumentNullException>(() => Protocol.Notice(null!));
    }
}
