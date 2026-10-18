using System.Runtime.InteropServices;

namespace JingjingReader;

/// <summary>
/// 通知 Windows 资源管理器刷新文件关联（.md 图标 / 打开方式缓存）。
/// <c>--install</c> / <c>--uninstall</c> 成功后调用；通知失败只记录日志，不能影响命令退出码。
/// </summary>
public static class ShellNotify
{
    // SHCNE_ASSOCCHANGED：文件关联变化；SHCNF_IDLIST：两个 ITEMIDLIST 参数均为空。
    private const int ShcneAssocChanged = 0x08000000;
    private const uint ShcnfIdList = 0x0000;

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    /// <summary>
    /// 触发一次资源管理器关联刷新（SHChangeNotify(SHCNE_ASSOCCHANGED)）。
    /// 任何异常（shell32 不可用 / 调用被拒）都吞掉并返回 false，绝不向上抛。
    /// </summary>
    public static bool AssociationsChanged()
    {
        try
        {
            SHChangeNotify(ShcneAssocChanged, ShcnfIdList, IntPtr.Zero, IntPtr.Zero);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
