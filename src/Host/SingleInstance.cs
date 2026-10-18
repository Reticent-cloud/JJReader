namespace JingjingReader;

/// <summary>
/// 单实例（Task 13）：命名 mutex 判定「我是主实例吗」，命名管道把后启动实例的文档路径转交给主实例。
/// <see cref="TryAcquire"/> 的 mutex 名字可注入（测试用 Local\ 随机名）；<see cref="PipeName"/> 与
/// App 里 <see cref="IpcServer.Start"/> 的管道名一致。
/// I4（修复波 B）：受限账户可能连 <c>Global\</c> 命名 mutex 都无法创建（UnauthorizedAccessException）；
/// TryAcquire 捕获后退化到 <c>Local\</c> 命名空间重试（同一会话内仍是单实例），绝不让启动变成未处理异常。
/// 若连 Local\ 也失败，则按「单实例失效」继续启动（宁可多开窗口，也不让程序打不开）。
/// </summary>
public static class SingleInstance
{
    /// <summary>主实例独占的 mutex 名（Global\ 前缀让同一台机器上的多个会话共享单实例）。</summary>
    public const string MutexName = "Global\\JingjingReader";

    /// <summary>管道名后缀：完整名字是当前有效 mutex 名 + <see cref="PipeSuffix"/>。</summary>
    private const string PipeSuffix = ".pipe";

    /// <summary>主实例持有的 mutex 句柄：字段保存防 GC 回收（句柄被回收会释放所有权，单实例失效）。</summary>
    private static Mutex? _held;

    /// <summary>当前实际使用的 mutex 名（Global 或退化后的 Local）；管道名必须跟着它走。</summary>
    public static string EffectiveMutexName { get; private set; } = MutexName;

    /// <summary>管道名：与 <see cref="App"/> 启动的 IpcServer 和 <see cref="TrySendAsync"/> 保持同源。</summary>
    public static string PipeName => EffectiveMutexName + PipeSuffix;

    /// <summary>
    /// 尝试成为主实例：true = 拿到了 mutex（或退化为单实例失效后继续启动）；false = 已有实例持有
    /// （调用方应转交参数后退出）。<paramref name="name"/> 仅用于测试注入，产品代码不传。
    /// </summary>
    public static bool TryAcquire(string name = MutexName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        try
        {
            EffectiveMutexName = name;
            return TryAcquireCore(name);
        }
        catch (UnauthorizedAccessException exception)
        {
            // I4：Global\ 对象可能被 ACL 拒绝（受限账户/其他用户创建的互斥体）。退化到 Local\ 重试：
            // 同一登录会话内的多开仍能转交；跨会话单实例在这种环境下本来就不可用。
            var fallback = ToLocalName(name);
            DebugLog.Write($"单实例 Mutex 无权限 name={name}，退化到 {fallback}：{exception.Message}");
            EffectiveMutexName = fallback;
            try
            {
                return TryAcquireCore(fallback);
            }
            catch (UnauthorizedAccessException fallbackException)
            {
                // 连 Local\ 也建不出来：按「单实例失效」继续启动（用户至少能打开程序），记日志即可。
                DebugLog.Write($"单实例 Mutex 完全不可用，按多实例继续启动：{fallbackException.Message}");
                EffectiveMutexName = fallback;
                return true;
            }
        }
    }

    /// <summary>把 <c>Global\x</c> 改成 <c>Local\x</c>；非 Global 名字原样返回（幂等）。</summary>
    internal static string ToLocalName(string name)
        => name.StartsWith(@"Global\", StringComparison.OrdinalIgnoreCase)
            ? @"Local\" + name[@"Global\".Length..]
            : name;

    private static bool TryAcquireCore(string name)
    {
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
        => IpcServer.SendAsync(PipeName, path, timeoutMs);
}
