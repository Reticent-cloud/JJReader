using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// ShellNotify：--install/--uninstall 成功后通知资源管理器刷新关联（SHChangeNotify）。
/// 只断言「不向上抛」：通知是 best-effort，任何环境（含受限测试宿主）失败都不能影响关联命令退出码。
/// </summary>
public class ShellNotifyTests
{
    [Fact]
    public void AssociationsChanged_never_throws()
    {
        var exception = Record.Exception(() => ShellNotify.AssociationsChanged());

        Assert.Null(exception);
    }
}
