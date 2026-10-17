using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// I4：SingleInstance 的 Global → Local 退化（受限账户无法创建 Global 命名对象）。
/// 实际的 UnauthorizedAccessException 由系统 ACL 决定，测试覆盖纯映射与失败路径；
/// 命名管道名必须跟有效 mutex 名同源。
/// </summary>
public class SingleInstanceTests
{
    [Theory]
    [InlineData(@"Global\JingjingReader", @"Local\JingjingReader")]
    [InlineData(@"global\jingjingreader", @"Local\jingjingreader")]
    [InlineData(@"Local\JingjingReader", @"Local\JingjingReader")]
    [InlineData("JingjingReader", "JingjingReader")]
    public void ToLocalName_rewrites_global_namespace(string name, string expected)
    {
        Assert.Equal(expected, SingleInstance.ToLocalName(name));
    }

    [Fact]
    public void PipeName_matches_effective_mutex_name()
    {
        Assert.Equal(SingleInstance.EffectiveMutexName + ".pipe", SingleInstance.PipeName);
    }

    [Fact]
    public void TryAcquire_rejects_blank_name()
    {
        Assert.Throws<ArgumentException>(() => SingleInstance.TryAcquire(" "));
    }
}
