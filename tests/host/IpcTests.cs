using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// Task 13 单实例转交：命名管道往返、无服务器失败、超长负载拒绝、空串激活、Stop 幂等，
/// 以及 <see cref="SingleInstance"/> 的 mutex 抢占（名字可注入，测试用 Local\ 随机名避免机器级冲突）。
/// </summary>
public class IpcTests
{
    private static string NewPipeName() => "JingjingReaderTest." + Guid.NewGuid().ToString("N");

    private static string NewMutexName() => "Local\\jj-test-" + Guid.NewGuid().ToString("N");

    [Fact]
    public async Task Ipc_roundtrip_delivers_path()
    {
        var pipe = NewPipeName();
        var got = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        IpcServer.Start(pipe, path => got.TrySetResult(path));
        try
        {
            Assert.True(await IpcServer.SendAsync(pipe, @"C:\notes\中文 目录#1\a.md"));

            Assert.Equal(
                @"C:\notes\中文 目录#1\a.md",
                await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public async Task Ipc_delivers_multiple_messages_in_order()
    {
        var pipe = NewPipeName();
        var received = new ConcurrentQueue<string>();
        var all = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IpcServer.Start(pipe, path =>
        {
            received.Enqueue(path);
            if (received.Count >= 3)
            {
                all.TrySetResult(true);
            }
        });
        try
        {
            Assert.True(await IpcServer.SendAsync(pipe, @"C:\a.md"));
            Assert.True(await IpcServer.SendAsync(pipe, @"C:\b.md"));
            Assert.True(await IpcServer.SendAsync(pipe, @"C:\c.md"));
            await all.Task.WaitAsync(TimeSpan.FromSeconds(3));

            Assert.Equal([@"C:\a.md", @"C:\b.md", @"C:\c.md"], received.ToArray());
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public async Task Ipc_send_fails_without_server()
    {
        Assert.False(await IpcServer.SendAsync(NewPipeName(), @"C:\a.md", 200));
    }

    [Fact]
    public async Task Ipc_delivers_empty_payload_for_activation()
    {
        // 第二个实例没带文档参数时发空串：主实例据此只激活已有窗口，不切换文档。
        var pipe = NewPipeName();
        var got = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        IpcServer.Start(pipe, path => got.TrySetResult(path));
        try
        {
            Assert.True(await IpcServer.SendAsync(pipe, string.Empty));

            Assert.Equal(string.Empty, await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public async Task Ipc_rejects_oversized_payload()
    {
        // 32KB 上限在客户端检查：超长负载不连接、不发送（服务器保持在线也不能收到）。
        var pipe = NewPipeName();
        var received = 0;
        IpcServer.Start(pipe, _ => Interlocked.Increment(ref received));
        try
        {
            Assert.False(await IpcServer.SendAsync(pipe, new string('x', 32 * 1024 + 1)));
            Assert.False(await IpcServer.SendAsync(pipe, new string('x', 64 * 1024)));

            await Task.Delay(100);
            Assert.Equal(0, received);
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public async Task Ipc_rejects_newline_in_payload()
    {
        // 一行一条消息：路径里带换行会让协议错位，必须拒绝发送
        Assert.False(await IpcServer.SendAsync(NewPipeName(), "C:\\a\nb.md", 200));
    }

    [Fact]
    public async Task Ipc_ignores_oversized_line_and_keeps_serving()
    {
        // 服务器自保：收到超长行时丢弃该连接，不能把后续正常消息一起吞掉。
        var pipe = NewPipeName();
        var got = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        IpcServer.Start(pipe, path => got.TrySetResult(path));
        try
        {
            await Task.Run(() => WriteRaw(pipe, new string('x', 32 * 1024 + 1024)));

            Assert.True(await IpcServer.SendAsync(pipe, "after-oversize", 3000));
            Assert.Equal("after-oversize", await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public async Task Ipc_stop_is_idempotent()
    {
        var pipe = NewPipeName();
        IpcServer.Start(pipe, _ => { });

        IpcServer.Stop();
        IpcServer.Stop(); // 幂等：重复 Stop 不抛异常

        Assert.False(await IpcServer.SendAsync(pipe, "x", 200));
    }

    [Fact]
    public async Task Ipc_restarts_after_stop()
    {
        var pipe = NewPipeName();
        var got = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        IpcServer.Start(pipe, _ => { });
        IpcServer.Stop();

        IpcServer.Start(pipe, path => got.TrySetResult(path));
        try
        {
            Assert.True(await IpcServer.SendAsync(pipe, "restarted"));
            Assert.Equal("restarted", await got.Task.WaitAsync(TimeSpan.FromSeconds(3)));
        }
        finally
        {
            IpcServer.Stop();
        }
    }

    [Fact]
    public void SingleInstance_acquires_free_mutex_first()
    {
        var name = NewMutexName();

        Assert.True(SingleInstance.TryAcquire(name));
        // 已经持有：同名的第二个实例拿不到（同一进程重复调用等价于第二个进程）
        Assert.False(SingleInstance.TryAcquire(name));
    }

    [Fact]
    public void SingleInstance_detects_existing_mutex()
    {
        var name = NewMutexName();
        using var held = new Mutex(false, name);
        held.WaitOne(); // 模拟另一个进程已持有
        try
        {
            Assert.False(SingleInstance.TryAcquire(name));
        }
        finally
        {
            held.ReleaseMutex();
        }
    }

    [Fact]
    public void SingleInstance_mutex_name_is_global_and_shared()
    {
        Assert.Equal(@"Global\JingjingReader", SingleInstance.MutexName);
    }

    /// <summary>绕过客户端 API 直接写一行（用于验证服务器对超长行的处理）；写失败是预期结果。</summary>
    private static void WriteRaw(string pipeName, string payload)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
            client.Connect(3000);
            var bytes = Encoding.UTF8.GetBytes(payload + "\n");
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
        }
        catch (Exception e) when (e is IOException or TimeoutException or UnauthorizedAccessException)
        {
            // 服务器读到超长行后主动断开连接：客户端写入失败属预期
        }
    }
}
