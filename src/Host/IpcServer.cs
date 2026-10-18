using System.IO;
using System.IO.Pipes;
using System.Text;

namespace JingjingReader;

/// <summary>
/// 单实例转交的命名管道服务端（Task 13）：主实例在后台线程循环监听「一行 UTF-8 文本」消息，
/// 后启动的实例把文档路径（或空串＝只激活窗口）发进来。
/// 设计约束：一条连接一条消息；负载上限 32 KB（超长行丢弃并继续监听）；
/// 任何异常都只记日志，绝不把宿主带崩；<see cref="Stop"/> 幂等。
/// </summary>
public static class IpcServer
{
    /// <summary>单条消息（一行）的 UTF-8 字节上限；超出时发送端拒绝、接收端丢弃。</summary>
    public const int MaxPayloadBytes = 32 * 1024;

    /// <summary>
    /// 单条连接读取上限（M9）：客户端连上却不发数据/只发半行时，2 s 后放弃该连接继续监听，
    /// 不能让一个哑连接把单实例转交通道永久占死。
    /// </summary>
    public const int ReadTimeoutMilliseconds = 2_000;

    private const int ReadBufferSize = 4096;

    /// <summary>发送失败后的重试次数（M9：短退避，覆盖主实例正在重建管道的瞬间）。</summary>
    private const int SendRetryCount = 2;

    private const int SendRetryBackoffMilliseconds = 50;

    /// <summary>保护 <see cref="_server"/><see cref="_thread"/><see cref="_running"/> 的互斥锁。</summary>
    private static readonly object Gate = new();

    private static NamedPipeServerStream? _server;
    private static Thread? _thread;
    private static volatile bool _running;

    /// <summary>
    /// 启动后台监听线程。重复调用先停掉旧监听（幂等，便于测试与异常重启）；
    /// <paramref name="onPath"/> 在后台线程回调，调用方负责切回 UI 线程。
    /// </summary>
    public static void Start(string pipeName, Action<string> onPath)
        => Start(pipeName, onPath, ReadTimeoutMilliseconds);

    /// <summary>测试用重载：注入更短的读超时（生产常量见 <see cref="ReadTimeoutMilliseconds"/>）。</summary>
    internal static void Start(string pipeName, Action<string> onPath, int readTimeoutMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        ArgumentNullException.ThrowIfNull(onPath);
        if (readTimeoutMs <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(readTimeoutMs), "读超时必须为正数。");
        }

        Stop();

        lock (Gate)
        {
            _running = true;
        }

        var thread = new Thread(() => ListenLoop(pipeName, onPath, readTimeoutMs))
        {
            IsBackground = true,
            Name = "JingjingReader.Ipc",
        };
        lock (Gate)
        {
            _thread = thread;
        }

        thread.Start();
    }

    /// <summary>
    /// 把一条消息发给另一个实例：true 表示已写出（不代表对方已处理）。
    /// 路径含换行（协议错位）或超过 32 KB 时拒绝发送；无服务器/超时返回 false。
    /// </summary>
    public static async Task<bool> SendAsync(string pipeName, string path, int timeoutMs = 500)
    {
        if (string.IsNullOrWhiteSpace(pipeName) || timeoutMs <= 0)
        {
            return false;
        }

        var payload = path ?? string.Empty;
        if (payload.Contains('\n') || payload.Contains('\r'))
        {
            return false;
        }

        var bytes = Encoding.UTF8.GetBytes(payload);
        if (bytes.Length > MaxPayloadBytes)
        {
            return false;
        }

        return await SendWithRetryAsync(_ => TrySendOnceAsync(pipeName, bytes, timeoutMs)).ConfigureAwait(false);
    }

    /// <summary>
    /// M9：单次失败后重试 2 次（退避 50/100 ms）。抽成 internal 便于单测覆盖重试次数；
    /// <paramref name="attempt"/> 收到 0 起始的尝试序号。
    /// </summary>
    internal static async Task<bool> SendWithRetryAsync(
        Func<int, Task<bool>> attempt,
        int retryDelayMs = SendRetryBackoffMilliseconds)
    {
        ArgumentNullException.ThrowIfNull(attempt);

        for (var attemptIndex = 0; attemptIndex <= SendRetryCount; attemptIndex++)
        {
            if (await attempt(attemptIndex).ConfigureAwait(false))
            {
                return true;
            }

            if (attemptIndex < SendRetryCount && retryDelayMs > 0)
            {
                await Task.Delay(retryDelayMs * (attemptIndex + 1)).ConfigureAwait(false);
            }
        }

        return false;
    }

    /// <summary>一次发送尝试：连接 → 写负载 → 写换行 → flush；任何失败返回 false。</summary>
    private static async Task<bool> TrySendOnceAsync(string pipeName, byte[] bytes, int timeoutMs)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
            using var timeout = new CancellationTokenSource(timeoutMs);
            await client.ConnectAsync(timeout.Token).ConfigureAwait(false);
            await client.WriteAsync(bytes, timeout.Token).ConfigureAwait(false);
            await client.WriteAsync(new byte[] { (byte)'\n' }, timeout.Token).ConfigureAwait(false);
            await client.FlushAsync(timeout.Token).ConfigureAwait(false);
            return true;
        }
        catch (Exception exception) when (exception is IOException or TimeoutException or OperationCanceledException
            or UnauthorizedAccessException or ArgumentException or ObjectDisposedException)
        {
            return false;
        }
    }

    /// <summary>停止监听（幂等）：置停止标记 → 关闭当前管道实例唤醒等待 → 最多等线程 2 s 退出。</summary>
    public static void Stop()
    {
        NamedPipeServerStream? server;
        Thread? thread;
        lock (Gate)
        {
            _running = false;
            server = _server;
            _server = null;
            thread = _thread;
            _thread = null;
        }

        try
        {
            server?.Dispose();
        }
        catch (Exception)
        {
            // 关闭已断开/已释放的管道不是错误
        }

        if (thread is null || thread == Thread.CurrentThread)
        {
            return;
        }

        try
        {
            thread.Join(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // Join 失败不影响停止语义：线程是后台线程，进程退出时随之结束
        }
    }

    private static void ListenLoop(string pipeName, Action<string> onPath, int readTimeoutMs)
    {
        while (_running)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.In,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    inBufferSize: MaxPayloadBytes,
                    outBufferSize: MaxPayloadBytes);
            }
            catch (Exception)
            {
                // 管道名非法/系统资源不足：结束监听，主实例仍可正常阅读
                return;
            }

            lock (Gate)
            {
                if (!_running)
                {
                    // Stop 在创建实例与登记之间发生：直接收尾，不再监听
                    server.Dispose();
                    return;
                }

                _server = server;
            }

            try
            {
                server.WaitForConnection();
                var payload = ReadPayload(server, readTimeoutMs);
                if (payload is not null)
                {
                    try
                    {
                        onPath(payload);
                    }
                    catch (Exception exception)
                    {
                        DebugLog.Write($"IPC 回调失败：{exception.Message}");
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException)
            {
                // Stop 关闭管道会打断 WaitForConnection/Read：正常退出路径
            }
            catch (Exception exception)
            {
                // 后台线程边界：任何意外都只记日志，绝不崩溃
                DebugLog.Write($"IPC 监听异常：{exception.Message}");
            }
            finally
            {
                lock (Gate)
                {
                    if (ReferenceEquals(_server, server))
                    {
                        _server = null;
                    }
                }

                try
                {
                    server.Dispose();
                }
                catch (Exception)
                {
                    // 已释放
                }
            }
        }
    }

    /// <summary>
    /// 读一行（到 \n 为止）；超长、连接提前关闭或超过 <paramref name="timeoutMs"/> 未读完返回 null
    /// （该连接被放弃，监听循环继续服务下一条连接）。
    /// </summary>
    internal static string? ReadPayload(Stream stream, int timeoutMs = ReadTimeoutMilliseconds)
    {
        ArgumentNullException.ThrowIfNull(stream);

        var buffer = new byte[ReadBufferSize];
        using var accumulated = new MemoryStream();
        using var timeout = new CancellationTokenSource();
        if (timeoutMs > 0)
        {
            timeout.CancelAfter(timeoutMs);
        }

        while (true)
        {
            int read;
            try
            {
                // 后台线程上用同步等待读取异步结果：取消令牌可打断哑客户端占住的等待。
                read = stream.ReadAsync(buffer.AsMemory(0, buffer.Length), timeout.Token)
                    .AsTask()
                    .GetAwaiter()
                    .GetResult();
            }
            catch (OperationCanceledException)
            {
                DebugLog.Write($"IPC 读取超时（{timeoutMs} ms），放弃该连接");
                return null;
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException)
            {
                return null;
            }

            if (read <= 0)
            {
                return null;
            }

            var newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
            if (newline >= 0)
            {
                if (accumulated.Length + newline > MaxPayloadBytes)
                {
                    return null;
                }

                accumulated.Write(buffer, 0, newline);
                return Decode(accumulated.ToArray());
            }

            accumulated.Write(buffer, 0, read);
            if (accumulated.Length > MaxPayloadBytes)
            {
                return null;
            }
        }
    }

    /// <summary>UTF-8 解码并容忍 CRLF 客户端（去掉行尾 \r）；空串原样返回（＝激活已有窗口）。</summary>
    private static string Decode(byte[] bytes)
    {
        var count = bytes.Length;
        if (count > 0 && bytes[count - 1] == (byte)'\r')
        {
            count -= 1;
        }

        return Encoding.UTF8.GetString(bytes, 0, count);
    }
}
