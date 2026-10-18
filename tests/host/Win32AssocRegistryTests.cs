using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// <see cref="Win32AssocRegistry"/> 的只读测试：只读本机不存在的键，不写任何注册表值。
/// 写入路径由 FakeRegistry 覆盖；真实注册表的写操作留给手动安装/卸载验证。
/// </summary>
public class Win32AssocRegistryTests
{
    [Fact]
    public void Reads_missing_key_as_absent_without_creating_it()
    {
        var keyPath = $@"Software\JingjingReader.Tests\{Guid.NewGuid():N}";
        var registry = new Win32AssocRegistry();

        Assert.False(registry.KeyExists(keyPath));
        Assert.Null(registry.GetValue(keyPath, null));
        Assert.Null(registry.GetValue(keyPath, "Missing"));
        Assert.Empty(registry.ReadValues(keyPath));
        // 读操作不能留下键（包括中间路径）。
        Assert.False(registry.KeyExists(keyPath));
    }
}
