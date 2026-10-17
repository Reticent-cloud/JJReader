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

    private const int ReadBufferSize = 4096;

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
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        ArgumentNullException.ThrowIfNull(onPath);

        Stop();

        lock (Gate)
        {
            _running = true;
        }

        var thread = new Thread(() => ListenLoop(pipeName, onPath))
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

    private static void ListenLoop(string pipeName, Action<string> onPath)
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
                var payload = ReadPayload(server);
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

    /// <summary>读一行（到 \n 为止）；超长或连接提前关闭返回 null（该连接被丢弃）。</summary>
    private static string? ReadPayload(Stream stream)
    {
        var buffer = new byte[ReadBufferSize];
        using var accumulated = new MemoryStream();
        while (true)
        {
            int read;
            try
            {
                read = stream.Read(buffer, 0, buffer.Length);
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
