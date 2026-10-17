namespace JingjingReader;

/// <summary>
/// 单实例（Task 13）：命名 mutex 判定「我是主实例吗」，命名管道把后启动实例的文档路径转交给主实例。
/// <see cref="TryAcquire"/> 的 mutex 名字可注入（测试用 Local\ 随机名）；<see cref="TrySendAsync"/> 固定发到
/// <see cref="MutexName"/> + <c>.pipe</c>，与 App 里 <see cref="IpcServer.Start"/> 的管道名一致。
/// </summary>
public static class SingleInstance
{
    /// <summary>主实例独占的 mutex 名（Global\ 前缀让同一台机器上的多个会话共享单实例）。</summary>
    public const string MutexName = "Global\\JingjingReader";

    /// <summary>管道名后缀：完整名字是 <see cref="MutexName"/> + <see cref="PipeSuffix"/>。</summary>
    private const string PipeSuffix = ".pipe";

    /// <summary>主实例持有的 mutex 句柄：字段保存防 GC 回收（句柄被回收会释放所有权，单实例失效）。</summary>
    private static Mutex? _held;

    /// <summary>
    /// 尝试成为主实例：true = 拿到了 mutex；false = 已有实例持有（调用方应转交参数后退出）。
    /// <paramref name="name"/> 仅用于测试注入，产品代码不传。
    /// </summary>
    public static bool TryAcquire(string name = MutexName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        var mutex = new Mutex(initiallyOwned: true, name, out var createdNew);
        if (!createdNew)
        {
            // 名字已存在（另一个实例持有）：本进程不是主实例，释放临时句柄
            mutex.Dispose();
            return false;
        }

        _held = mutex;
        return true;
    }

    /// <summary>
    /// 把路径发给主实例（空串＝只激活已有窗口）。失败（主实例还没开始监听/管道不可用）返回 false，调用方照常退出。
    /// </summary>
    public static Task<bool> TrySendAsync(string path, int timeoutMs = 500)
        => IpcServer.SendAsync(MutexName + PipeSuffix, path, timeoutMs);
}
