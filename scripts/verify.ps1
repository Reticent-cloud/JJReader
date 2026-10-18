#Requires -Version 5.1
<#
鲸鲸阅读器验收脚本（Task 17，spec §9.3；修复波 C/D 加固）。

做什么：
   0. 验收脚本自测（-SelfTest 的 21 例纯函数样本；正常验收也先跑这一项，断言总数 21 且 0 失败）
   1. 构建（scripts/build.ps1）
   2. 宿主单测（dotnet test；skipped > 0 判 FAIL）
   3. 前端单测（web/ 下 npm test；skipped > 0 判 FAIL）
   4. 把 out\ 复制到 ASCII 临时目录，后续启动实测都用这份副本（数据目录隔离到 <temp>\appdata）
   5. 分发包完整性：out\ 内 exe + install.ps1 + uninstall.ps1 + README.md
   6. --selftest：产品名 / .NET / WebView2 / OS
   7. --verify-render samples/full-syntax.md：首屏 ≤ 1000 ms、tocCount ∈ [36, 40]
   8. 端到端首屏：Process.Start → stdout 出现 READY 的墙钟耗时（< 1000 ms PASS；≤ 2500 ms WARN；> 2500 ms FAIL）
   9. --verify-render samples/huge-50k-lines.md：exit 0、READY 严格校验、首屏 ≤ 1500 ms、tocCount ≥ 480，
      外层超时 60 s（干净超时重试 1 次并记录历史；重试前清理 WebView2 后代与临时 profile）；
      宿主私有内存峰值 ≤ 200 MB（采样最大间隔 > 250 ms 判 FAIL）
  10. --verify-pdf：hello > 5 KB；5 万行文档 > 1 MB 且页数 > 100
  11. 双开单实例：第 2 个进程 ExitCode == 0、JingjingReader 进程数 = 1
  12. 前端产物 ≤ 500 KB，且 web/dist 与 src/Host/Resources 两份字节一致
  13. 用户 %APPDATA%\JingjingReader\recent.json 未被改写（mtime/哈希前后一致）
  14. 写 out/verify-report.md，终端打印 VERIFY OK / VERIFY FAILED

约定：
  - 每步输出 [PASS]/[WARN]/[FAIL] 名称 详情；失败不中断，继续跑完并汇总，最终 exit 1。
    WARN 不计入失败（仅端到端首屏在 1000–2500 ms 时使用）。
  - 不在本脚本里安装/卸载 .md 关联（不写注册表）：那属于 install.ps1/uninstall.ps1 与手测清单。
  - 隔离：本脚本创建纯 ASCII 临时目录，并把 JJ_DATA_DIR 指向 <临时目录>\appdata（settings/recent/
    positions/debug.log 与 WebView2 profile 都在其中），所有 exe 调用显式传入该环境变量；
    验收结束后校验用户 %APPDATA%\JingjingReader 未被改写。JJ_DATA_DIR 仅用于测试隔离：
    finally 恢复调用方原有值（存在还原、不存在删除）；产品默认 UDF 仍是本地
    %LOCALAPPDATA%\JingjingReader\WebView2。
  - 超时路径：kill 根进程后 stdout/stderr 的异步读取一律带 5 s 超时（Receive-TaskText），
    管道不关闭时丢弃输出继续，不能无界 .Result 等待。
  - 内存判定口径（Controller 裁定，T17 修正）：宿主进程（JingjingReader.exe）的 PrivateMemorySize64
    （Private Bytes）峰值 ≤ 200 MB，50 ms 采样取峰值。WebView2 进程组（直接子进程与全部后代）
    的 WorkingSet64 之和只作为信息项记录，不参与 PASS/FAIL；对应 spec §2.3 第 2 条。
  - 裁定 2（2026-10-18）：上限由 150 MB 修正为 200 MB（WebView2 155 下宿主实测基线
    160.6–171.9 MB，原 150 MB 为设计阶段未实测预算）；150 MB 保留为后续优化目标。
  - READY 严格校验：`ready` 必须是 JSON boolean true、`elapsedMs` 必须是 [0, 上限] 内的 Number、
    `path` 必须非空且与传入文件一致（归一化后比较）、`tocCount` 必须为 [下限, 上限] 内的整数；任何一项
    不满足都判 FAIL 并打印原始 READY 行。
  - 采样保真：宿主内存采样最大间隔 > 250 ms 判 FAIL（防止采样空洞导致峰值假通过）；报告记录采样次数
    与最大间隔。5 万行渲染未成功时内存项记「不适用/FAIL」，不得判 PASS。
  - 清理安全：启动时记录 (PID, StartTime, ImagePath)；杀进程树前校验 PID 仍存在且 StartTime/ImagePath
    匹配，否则跳过；报告残留检查结果。
  - 临时目录：优先 %TEMP%\jj-verify-<guid>；若路径含非 ASCII 字符，依次回退
    %LOCALAPPDATA%\Temp、脚本所在盘根目录下的 jj-verify-<guid>（隔离 + 路径含中文时的兼容）。
    结束后清理；只停止本脚本启动的宿主进程及其后代。
  - 验收开始先删除旧 out/verify-report.md（避免旧报告冒充本次结果）。

用法：
  pwsh -NoProfile -File scripts/verify.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
  pwsh -NoProfile -File scripts/verify.ps1 -SelfTest   # 只跑脚本自身纯函数自测（不构建、不启动产品）
#>
[CmdletBinding()]
param(
    # 验收脚本自测：对 Test-ReadyPayload / Test-HostTestSummary / Find-PdfReadyJson 等纯函数喂固定样本，
    # 打印每例 PASS/FAIL 并 exit 0/1；不构建、不运行产品。
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# 输出统一 UTF-8：中文在管道/CI 重定向下不按系统代码页（GBK）乱码。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root 'out'
$WebDir = Join-Path $Root 'web'
$SamplesDir = Join-Path $Root 'samples'
$ReportPath = Join-Path $OutDir 'verify-report.md'
$BuildScript = Join-Path $Root 'scripts/build.ps1'
$TestProject = Join-Path $Root 'tests/host/JingjingReader.Tests.csproj'

$MB = 1024 * 1024
# 修复波 D：-SelfTest 断言固定样本总数（21）且 0 失败；用例被误删/漏注册时不能只看「零失败」。
$ExpectedSelfTestCases = 21
# 判定上限统一从这里引用：内存上限（MB）同时用于判定与文案，避免两处数字漂移。
$MemoryLimitMb = 200
$MemoryLimitBytes = $MemoryLimitMb * $MB
$FullElapsedLimitMs = 1000
$HugeElapsedLimitMs = 1500
# 语法样本的 TOC 实际值：full-syntax 38（断言 36–40），huge 500（断言 ≥ 480）。
$FullTocMin = 36
$FullTocMax = 40
$HugeTocMin = 480
# 端到端首屏：Process.Start → stdout READY 的墙钟耗时（含进程启动/WebView2 初始化/文件读取）。
# spec 的 1.0 s 是渲染器口径设计目标；当前 CLI 冷启动含 WebView2 初始化，1000–2500 ms 记 WARN 而不是 FAIL。
$E2ePassMs = 1000
$E2eWarnMs = 2500
# 5 万行外层超时：旧值 180 s 曾掩盖挂起；干净超时允许重试 1 次（History 记录尝试次数）。
$HugeTimeoutSeconds = 60
# 宿主内存采样最大间隔：超过即判 FAIL（采样空洞可能漏掉峰值）。
$HostSampleMaxGapLimitMs = 250
# 采样口径（方案 A）：宿主每 50 ms 采 PrivateMemorySize64（循环内不做 CIM）；
# WebView2 进程组每 500 ms 由后台 runspace 采样，只作信息项。
$HostSampleIntervalMs = 50
$WebViewSampleIntervalMs = 500
$PdfHelloLimitBytes = 5 * 1024
$PdfHugeLimitBytes = 1 * $MB
$ArtifactLimitBytes = 500 * 1024

$Results = New-Object System.Collections.ArrayList
$Failures = 0
$TempRoot = $null
$TempRootSource = ''
$TempRootReason = ''
$JjDataDir = $null
$Exe = $null
$SelftestText = ''
$OurAppPids = New-Object 'System.Collections.Generic.HashSet[int]'
# I8：启动时记录 (PID, StartTime, ImagePath)，杀进程前校验，避免 PID 复用杀错进程树。
$TrackedProcesses = @{}
$CleanupNotes = New-Object System.Collections.Generic.List[string]
$AppDataRecentPath = Join-Path $env:APPDATA 'JingjingReader/recent.json'
$AppDataRecentBefore = $null
$StartedAt = Get-Date

# 验收开始先删除旧报告：本次失败/中断时不能留下上一次的 VERIFY OK 报告。
# -SelfTest 只跑脚本自身纯函数（不构建、不产生报告），不删除已有验收证据。
if (-not $SelfTest -and (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
    Remove-Item -LiteralPath $ReportPath -Force -ErrorAction SilentlyContinue
}

# ── 通用小工具 ────────────────────────────────────────────────────────────────

function Add-Result {
    param(
        [string]$Name,
        [string]$Expect,
        [string]$Actual,
        [bool]$Pass,
        [string]$Detail = '',
        # 显式状态优先（端到端首屏的 WARN 不计入失败）；未传时按 Pass 推导 PASS/FAIL。
        [ValidateSet('', 'PASS', 'WARN', 'FAIL')]
        [string]$Status = ''
    )
    if (-not $Status) {
        $Status = if ($Pass) { 'PASS' } else { 'FAIL' }
    }
    $null = $Results.Add([pscustomobject]@{
            Name   = $Name
            Expect = $Expect
            Actual = $Actual
            Status = $Status
            Detail = $Detail
        })
    $color = switch ($Status) {
        'PASS' { 'Green' }
        'WARN' { 'Yellow' }
        default { 'Red' }
    }
    Write-Host "[$Status] $Name：$Actual" -ForegroundColor $color
    if ($Status -eq 'FAIL') {
        $script:Failures += 1
    }
}

function Quote-Argument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -match '[\s"]') {
        # 路径里最常见的是空格；引号本身极少见，按 Windows 命令行规则把 " 换成 \"。
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

function Read-Utf8File {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try {
        return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
    } catch {
        return ''
    }
}

function Get-FileState {
    <#
      记录文件的「是否存在 + 大小 + 最后写入时间 + SHA256」快照，用于验收前后比对
      （用户 %APPDATA%\JingjingReader\recent.json 未被改写）。
    #>
    param([string]$Path)
    $state = [pscustomobject]@{
        Exists       = $false
        Length       = [long]0
        LastWriteUtc = $null
        Hash         = ''
        Error        = ''
    }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $state
        }
        $info = Get-Item -LiteralPath $Path
        $state.Exists = $true
        $state.Length = [long]$info.Length
        $state.LastWriteUtc = $info.LastWriteTimeUtc.ToString('o')
        $state.Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    } catch {
        $state.Error = $_.Exception.Message
    }
    return $state
}

function Format-FileState {
    param($State)
    if ($null -eq $State) { return '未采集' }
    if (-not $State.Exists) { return '不存在' }
    $hash = if ($State.Hash) { $State.Hash.Substring(0, [Math]::Min(12, $State.Hash.Length)) } else { '无哈希' }
    return "存在，$($State.Length) B，mtime=$($State.LastWriteUtc)，SHA256=$hash…"
}

function Get-DebugLogTail {
    # 读取隔离数据目录下 debug.log 的尾部（5 万行超时/失败时附到报告，便于定位挂起原因）。
    param([string]$Path, [int]$MaxLines = 20, [int]$MaxChars = 1600)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return '（debug.log 不存在）'
    }
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader -ArgumentList $stream, ([System.Text.UTF8Encoding]::new($false))
            $text = $reader.ReadToEnd()
            $reader.Dispose()
        } finally {
            $stream.Dispose()
        }
        $lines = @($text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
        $tail = @($lines | Select-Object -Last $MaxLines) -join ' | '
        if ($tail.Length -gt $MaxChars) {
            $tail = '…' + $tail.Substring($tail.Length - $MaxChars)
        }
        return $tail
    } catch {
        return '（debug.log 读取失败：' + $_.Exception.Message + '）'
    }
}

function Format-Mb {
    param([long]$Bytes)
    return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:0.0} MB', ($Bytes / $MB))
}

function Test-AsciiOnly {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    return ($Text -notmatch '[^\x00-\x7F]')
}

function Resolve-AsciiTempRoot {
    <#
      验收运行副本必须位于纯 ASCII 路径：启动的 WebView2 子进程会在该目录创建用户数据目录，
      且 --verify-* 的命令行/环境变量在非 ASCII 路径上受系统代码页影响。
      回退顺序：%TEMP% → %LOCALAPPDATA%\Temp → 脚本所在盘根目录；候选目录必须实际创建成功。
    #>
    $guid = [guid]::NewGuid().ToString('N')
    $attempts = New-Object System.Collections.Generic.List[string]
    $candidates = New-Object System.Collections.Generic.List[object]

    $systemTemp = ''
    try { $systemTemp = [System.IO.Path]::GetTempPath() } catch { $systemTemp = '' }
    if ($systemTemp) {
        $candidates.Add([pscustomobject]@{
                Path  = [System.IO.Path]::Combine($systemTemp, ('jj-verify-' + $guid))
                Label = '%TEMP%'
            })
    }
    if ($env:LOCALAPPDATA) {
        $candidates.Add([pscustomobject]@{
                Path  = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Temp', ('jj-verify-' + $guid))
                Label = '%LOCALAPPDATA%\Temp'
            })
    }
    $driveRoot = ''
    try { $driveRoot = [System.IO.Path]::GetPathRoot($PSScriptRoot) } catch { $driveRoot = '' }
    if ($driveRoot) {
        $candidates.Add([pscustomobject]@{
                Path  = [System.IO.Path]::Combine($driveRoot, ('jj-verify-' + $guid))
                Label = '脚本所在盘根目录'
            })
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-AsciiOnly $candidate.Path)) {
            $attempts.Add("$($candidate.Label) 含非 ASCII 字符，跳过：$($candidate.Path)")
            continue
        }
        try {
            $null = [System.IO.Directory]::CreateDirectory($candidate.Path)
            $reason = if ($candidate.Label -eq '%TEMP%') {
                '路径为纯 ASCII'
            } else {
                '因 %TEMP% 含非 ASCII 字符或不可用，回退到 ' + $candidate.Label
            }
            return [pscustomobject]@{
                Root    = $candidate.Path
                Source  = $candidate.Label
                Reason  = $reason
                Attempts = ($attempts -join '；')
            }
        } catch {
            $attempts.Add("$($candidate.Label) 创建失败：$($candidate.Path)（$($_.Exception.Message)）")
        }
    }

    return [pscustomobject]@{
        Root     = ''
        Source   = ''
        Reason   = '没有可用的纯 ASCII 临时目录'
        Attempts = ($attempts -join '；')
    }
}

function Get-MatchValue {
    param([string]$Text, [string]$Pattern)
    $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success -and $match.Groups.Count -ge 2) {
        return $match.Groups[1].Value.Trim()
    }
    return ''
}

function Receive-TaskText {
    <#
      读取 ReadToEndAsync 的 Task 结果，带超时（默认 5 s）：进程被强杀后管道可能永远不关闭，
      无界 .Result 会让脚本在超时路径上永久挂起。超时/异常一律返回 ''，由调用方继续
      按「超时=True + 已收集到的输出」记录，不阻塞后续清理与报告。
    #>
    param(
        $Task,
        [int]$TimeoutMs = 5000
    )
    if ($null -eq $Task) { return '' }
    try {
        if (-not $Task.Wait($TimeoutMs)) {
            return ''
        }
        return [string]$Task.Result
    } catch {
        return ''
    }
}

function Invoke-Captured {
    <#
      启动一个控制台/图形进程，stdout/stderr 用 .NET Process 的异步读取捕获（UTF-8），带超时。
      返回 @{ ExitCode; StdOut; StdErr; TimedOut }。
      不用 Start-Process -PassThru：Windows PowerShell 5.1 里配合 WaitForExit(timeout) 时
      ExitCode 会取不到（返回 $null），会让所有启动实测被误判为失败。
    #>
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $Root,
        [int]$TimeoutMs = 600000,
        # 显式环境变量（验收隔离：JJ_DATA_DIR 必须传给每个 exe 调用，而不是依赖父进程环境）。
        [hashtable]$Environment = @{}
    )
    $argumentList = @()
    foreach ($argument in $Arguments) {
        $argumentList += (Quote-Argument ([string]$argument))
    }
    $commandLine = ($argumentList -join ' ')

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($key in $Environment.Keys) {
        $startInfo.EnvironmentVariables[[string]$key] = [string]$Environment[$key]
    }

    # npm 是 npm.cmd（批处理）：UseShellExecute=false 时不能直接 CreateProcess，交给 cmd /c call。
    if ($FilePath -match '\.(cmd|bat)$') {
        $startInfo.FileName = $env:ComSpec
        $startInfo.Arguments = '/d /c call ' + (Quote-Argument $FilePath) + $(if ($commandLine) { ' ' + $commandLine } else { '' })
    } else {
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $commandLine
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $null = $process.Start()
    # 只登记本次验收从副本 exe 启动的宿主；dotnet/npm/pwsh 不算，清理时不会误伤。
    if ($Exe -and ($FilePath -eq $Exe)) {
        Register-TrackedProcess -Process $process -ExpectedPath $Exe
    }

    # 先挂异步读取再等待退出：避免子进程写满管道缓冲而卡死。
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutMs)
    if ($timedOut) {
        try { $process.Kill() } catch { }
    }

    $stdout = ''
    $stderr = ''
    # 修复波 D：超时路径不能无界等待异步读取（kill 后管道可能不关闭）。
    $stdout = Receive-TaskText -Task $stdoutTask -TimeoutMs 5000
    $stderr = Receive-TaskText -Task $stderrTask -TimeoutMs 5000
    $exitCode = -1
    try {
        if ($process.HasExited) { $exitCode = [int]$process.ExitCode }
    } catch {
        $exitCode = -1
    }
    $process.Dispose()

    return [pscustomobject]@{
        ExitCode = $exitCode
        StdOut   = $stdout
        StdErr   = $stderr
        TimedOut = $timedOut
    }
}

function Invoke-CapturedFirstReady {
    <#
      启动 exe 并记录「Process.Start → stdout 出现 READY」的墙钟耗时（端到端首屏口径）。
      与 Invoke-Captured 的区别：stdout 按块异步读取并在数据到达时打时间戳，而不是等进程退出
      （进程退出还包含关闭 WebView2 的时间，不能当作首屏）。
      返回 @{ ExitCode; StdOut; StdErr; TimedOut; FirstReadyMs }；FirstReadyMs 未出现 READY 时为 $null。
    #>
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $Root,
        [int]$TimeoutMs = 60000,
        [hashtable]$Environment = @{}
    )
    $argumentList = @()
    foreach ($argument in $Arguments) {
        $argumentList += (Quote-Argument ([string]$argument))
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = ($argumentList -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($key in $Environment.Keys) {
        $startInfo.EnvironmentVariables[[string]$key] = [string]$Environment[$key]
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $null = $process.Start()
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Exe -and ($FilePath -eq $Exe)) {
        Register-TrackedProcess -Process $process -ExpectedPath $Exe
    }

    $stdout = New-Object System.Text.StringBuilder
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $buffer = New-Object char[] 4096
    $readTask = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
    $firstReadyMs = $null
    $timedOut = $false

    while (-not $process.HasExited) {
        if ($null -ne $readTask -and $readTask.IsCompleted) {
            try {
                $count = [int]$readTask.Result
            } catch {
                $count = 0
            }
            if ($count -le 0) {
                $readTask = $null
            } else {
                $null = $stdout.Append($buffer, 0, $count)
                if ($null -eq $firstReadyMs -and $stdout.ToString() -match '(?m)^READY\s+\{') {
                    $firstReadyMs = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
                }
                $readTask = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            }
        }
        if ($stopwatch.Elapsed.TotalMilliseconds -gt $TimeoutMs) {
            $timedOut = $true
            try { $process.Kill() } catch { }
            break
        }
        Start-Sleep -Milliseconds 5
    }

    # 进程退出后把剩余 stdout 吸干（最多等 3 s，避免异常流导致脚本挂起）。
    $drainDeadline = (Get-Date).AddSeconds(3)
    while ($null -ne $readTask -and (Get-Date) -lt $drainDeadline) {
        if (-not $readTask.IsCompleted) {
            Start-Sleep -Milliseconds 10
            continue
        }
        try {
            $count = [int]$readTask.Result
        } catch {
            $count = 0
        }
        if ($count -le 0) {
            $readTask = $null
            break
        }
        $null = $stdout.Append($buffer, 0, $count)
        if ($null -eq $firstReadyMs -and $stdout.ToString() -match '(?m)^READY\s+\{') {
            $firstReadyMs = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
        }
        $readTask = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
    }
    try { $null = $process.WaitForExit(10000) } catch { }

    $stderr = ''
    # 修复波 D：超时 kill 后 stderr 管道可能一直不关闭，读取必须带超时。
    $stderr = Receive-TaskText -Task $stderrTask -TimeoutMs 5000
    $exitCode = -1
    try {
        if ($process.HasExited) { $exitCode = [int]$process.ExitCode }
    } catch {
        $exitCode = -1
    }
    try { $process.Dispose() } catch { }

    return [pscustomobject]@{
        ExitCode     = $exitCode
        StdOut       = $stdout.ToString()
        StdErr       = $stderr
        TimedOut     = $timedOut
        FirstReadyMs = $firstReadyMs
    }
}

function Invoke-HugeRenderProbe {
    <#
      5 万行首屏一次启动尝试：启动 WebView2 采样器 + 宿主 --verify-render，主线程每 50 ms 采宿主
      PrivateMemorySize64，外层超时 60 s（修复波 C-I7）。返回完整采样结果与超时标记；
      调用方在「干净超时」时重试 1 次并记录尝试历史。
    #>
    param(
        [string]$FilePath,
        [string]$WorkDir,
        [int]$TimeoutSeconds = 60
    )
    $result = [pscustomobject]@{
        Launched          = $false
        ProcessId         = 0
        ExitCode          = -1
        TimedOut          = $false
        StdOut            = ''
        StdErr            = ''
        PeakPrivateBytes  = [long]0
        MemorySamples     = 0
        HostSampleMaxGapMs = 0
        FirstSampleMs     = -1
        WebView           = [pscustomobject]@{
            Bytes = [long]0; Count = 0; TreeBytes = [long]0; TreeApplicable = $false; Samples = 0; Error = $true
        }
        Error             = ''
    }
    $startFile = Join-Path $WorkDir 'webview-sampler.start'
    $stopFile = Join-Path $WorkDir 'webview-sampler.stop'
    $resultFile = Join-Path $WorkDir 'webview-sampler.json'
    $readyFile = Join-Path $WorkDir 'webview-sampler.ready'
    $process = $null
    $sampler = $null
    try {
        foreach ($samplerFile in @($startFile, $stopFile, $resultFile, $readyFile)) {
            if (Test-Path -LiteralPath $samplerFile) {
                Remove-Item -LiteralPath $samplerFile -Force -ErrorAction SilentlyContinue
            }
        }
        $sampler = Start-WebViewSampler -StartFile $startFile `
            -StopFile $stopFile -ResultFile $resultFile -ReadyFile $readyFile `
            -IntervalMs $WebViewSampleIntervalMs
        $readyDeadline = (Get-Date).AddSeconds(5)
        while ((-not (Test-Path -LiteralPath $readyFile)) -and ((Get-Date) -lt $readyDeadline)) {
            Start-Sleep -Milliseconds 20
        }

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Exe
        $startInfo.Arguments = '--verify-render ' + (Quote-Argument $FilePath)
        $startInfo.WorkingDirectory = $WorkDir
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
        if ($JjDataDir) {
            $startInfo.EnvironmentVariables['JJ_DATA_DIR'] = $JjDataDir
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        $null = $process.Start()
        $result.Launched = $true
        $result.ProcessId = [int]$process.Id
        Register-TrackedProcess -Process $process -ExpectedPath $Exe
        [System.IO.File]::WriteAllText($startFile, [string]$process.Id, [System.Text.UTF8Encoding]::new($false))
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $nextHostSampleMs = 0
        $lastHostSampleMs = $null
        while (-not $process.HasExited) {
            $nowMs = $stopwatch.Elapsed.TotalMilliseconds
            if ($nowMs -ge $nextHostSampleMs) {
                $samplePrivate = [long]0
                try {
                    $process.Refresh()
                    $samplePrivate = [long]$process.PrivateMemorySize64
                } catch {
                    $samplePrivate = [long]0
                }
                if ($samplePrivate -gt 0) {
                    $result.MemorySamples += 1
                    if ($samplePrivate -gt $result.PeakPrivateBytes) {
                        $result.PeakPrivateBytes = $samplePrivate
                    }
                    if ($result.FirstSampleMs -lt 0) {
                        $result.FirstSampleMs = [int][math]::Round($nowMs)
                        # 第一段间隔 = 启动到首个样本：防止启动瞬间的采样空洞漏掉峰值。
                        $result.HostSampleMaxGapMs = $result.FirstSampleMs
                    }
                    if ($null -ne $lastHostSampleMs) {
                        $gapMs = [int][math]::Round($nowMs - $lastHostSampleMs)
                        if ($gapMs -gt $result.HostSampleMaxGapMs) {
                            $result.HostSampleMaxGapMs = $gapMs
                        }
                    }
                    $lastHostSampleMs = $nowMs
                }
                $nextHostSampleMs = $nowMs + $HostSampleIntervalMs
            }
            if ($stopwatch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
                $result.TimedOut = $true
                try { $process.Kill() } catch { }
                break
            }
            Start-Sleep -Milliseconds 10
        }

        try { $null = $process.WaitForExit(10000) } catch { }
        New-Item -ItemType File -Path $stopFile -Force -ErrorAction SilentlyContinue | Out-Null
        $result.WebView = Receive-WebViewSampler -Sampler $sampler -TimeoutMs 20000
        $sampler = $null
        # 修复波 D：超时 kill 后两路管道都可能一直不关闭，读取必须带超时。
        $result.StdOut = Receive-TaskText -Task $stdoutTask -TimeoutMs 5000
        $result.StdErr = Receive-TaskText -Task $stderrTask -TimeoutMs 5000
        try {
            if ($process.HasExited) { $result.ExitCode = [int]$process.ExitCode }
        } catch {
            $result.ExitCode = -1
        }
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        if ($sampler) {
            New-Item -ItemType File -Path $stopFile -Force -ErrorAction SilentlyContinue | Out-Null
            try { $result.WebView = Receive-WebViewSampler -Sampler $sampler -TimeoutMs 5000 } catch { }
        }
        try { if ($process) { $process.Dispose() } } catch { }
    }
    return $result
}

function Get-JsonTypeName {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    return $Value.GetType().Name
}

function Test-PathEqualForVerify {
    # READY 里的 path 与传入文件归一化后比较（盘符大小写、斜杠方向不同不算差异）。
    param([string]$Actual, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Actual) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
    try {
        $separators = [char[]]@([char]'\', [char]'/')
        $left = [System.IO.Path]::GetFullPath($Actual).TrimEnd($separators)
        $right = [System.IO.Path]::GetFullPath($Expected).TrimEnd($separators)
        return [string]::Equals($left, $right, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-ReadyPayload {
    <#
      严格校验 --verify-render 的 READY JSON，任何一项不满足都返回 Ok=false + Reason：
        ready    必须是 JSON boolean true（字符串 "false"/"true" 一律拒绝）；
        elapsedMs 必须是 [0, MaxElapsedMs] 内的 Number（缺失、null、负值、字符串都拒绝）；
        path     必须是非空字符串，且与传入文件归一化后一致；
        tocCount 必须是 >= MinTocCount 的整数（0 对 5 万行文档也拒绝）。
      调用方在失败时负责打印原始 READY 行。
    #>
    param(
        [string]$RawJson,
        [string]$ExpectedPath,
        [double]$MaxElapsedMs = 1500,
        [int]$MinTocCount = 0,
        # 上限用于锁住「实际标题数」：full-syntax 期望 38 个标题（36–40），避免只断下界。
        [int]$MaxTocCount = [int]::MaxValue
    )
    $result = [pscustomobject]@{
        Ok        = $false
        Reason    = ''
        ElapsedMs = $null
        TocCount  = $null
        Path      = ''
        Raw       = $RawJson
    }
    if ([string]::IsNullOrWhiteSpace($RawJson)) {
        $result.Reason = 'READY 行为空'
        return $result
    }
    $payload = $null
    try {
        $payload = $RawJson | ConvertFrom-Json
    } catch {
        $result.Reason = 'READY JSON 解析失败：' + $_.Exception.Message
        return $result
    }
    if ($null -eq $payload -or $payload -isnot [pscustomobject]) {
        $result.Reason = 'READY 不是 JSON 对象（实际 ' + (Get-JsonTypeName $payload) + '）'
        return $result
    }

    # ready：必须是 JSON boolean true。
    $readyProperty = $payload.PSObject.Properties['ready']
    if (-not $readyProperty) {
        $result.Reason = '缺少 ready 字段'
        return $result
    }
    if (-not ($readyProperty.Value -is [bool])) {
        $result.Reason = 'ready 必须是 JSON boolean true（实际类型 ' + (Get-JsonTypeName $readyProperty.Value) + '）'
        return $result
    }
    if ($readyProperty.Value -ne $true) {
        $result.Reason = 'ready 不为 true'
        return $result
    }

    # path：非空字符串，且与传入文件一致。
    $pathProperty = $payload.PSObject.Properties['path']
    if (-not $pathProperty) {
        $result.Reason = '缺少 path 字段'
        return $result
    }
    if (-not ($pathProperty.Value -is [string])) {
        $result.Reason = 'path 必须是字符串（实际类型 ' + (Get-JsonTypeName $pathProperty.Value) + '）'
        return $result
    }
    $readyPath = [string]$pathProperty.Value
    $result.Path = $readyPath
    if ([string]::IsNullOrWhiteSpace($readyPath)) {
        $result.Reason = 'path 为空'
        return $result
    }
    if (-not (Test-PathEqualForVerify -Actual $readyPath -Expected $ExpectedPath)) {
        $result.Reason = "path 与传入文件不一致：READY=$readyPath，期望=$ExpectedPath"
        return $result
    }

    # elapsedMs：Number 且在 [0, 上限] 内。
    $elapsedProperty = $payload.PSObject.Properties['elapsedMs']
    if (-not $elapsedProperty) {
        $result.Reason = '缺少 elapsedMs 字段'
        return $result
    }
    $elapsedValue = $elapsedProperty.Value
    $isNumber = ($elapsedValue -is [int]) -or ($elapsedValue -is [long]) -or
        ($elapsedValue -is [double]) -or ($elapsedValue -is [decimal]) -or ($elapsedValue -is [single])
    if ($null -eq $elapsedValue -or -not $isNumber) {
        $result.Reason = 'elapsedMs 必须是 Number（实际 ' + (Get-JsonTypeName $elapsedValue) + '）'
        return $result
    }
    $elapsedDouble = [double]$elapsedValue
    if ([double]::IsNaN($elapsedDouble) -or [double]::IsInfinity($elapsedDouble)) {
        $result.Reason = 'elapsedMs 不是有限数值'
        return $result
    }
    if (($elapsedDouble -lt 0) -or ($elapsedDouble -gt $MaxElapsedMs)) {
        $result.Reason = "elapsedMs 超出 [0, $MaxElapsedMs]：$elapsedValue"
        return $result
    }
    $result.ElapsedMs = $elapsedValue

    # tocCount：[MinTocCount, MaxTocCount] 内的整数（上限锁实际值，不只断下界）。
    $tocProperty = $payload.PSObject.Properties['tocCount']
    if (-not $tocProperty) {
        $result.Reason = '缺少 tocCount 字段'
        return $result
    }
    $tocValue = $tocProperty.Value
    if (-not (($tocValue -is [int]) -or ($tocValue -is [long]))) {
        $result.Reason = 'tocCount 必须是整数（实际 ' + (Get-JsonTypeName $tocValue) + '）'
        return $result
    }
    if ([long]$tocValue -lt $MinTocCount) {
        $result.Reason = "tocCount 小于 $MinTocCount：$tocValue"
        return $result
    }
    if ([long]$tocValue -gt $MaxTocCount) {
        $result.Reason = "tocCount 大于 $MaxTocCount：$tocValue"
        return $result
    }
    $result.TocCount = [long]$tocValue

    $result.Ok = $true
    $result.Reason = 'ok'
    return $result
}

function Find-ReadyJson {
    # 返回 READY 行的原始 JSON 文本；解析与字段校验交给 Test-ReadyPayload。
    param([string]$Text)
    $match = [regex]::Match($Text, '(?m)^READY\s+(\{.*\})\s*$')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value
}

function Find-PdfReadyJson {
    param([string]$Text)
    $match = [regex]::Match($Text, '(?m)^PDF-READY\s+(\{.*\})\s*$')
    if (-not $match.Success) { return $null }
    try {
        return ($match.Groups[1].Value | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-ShortText {
    param([string]$Text, [int]$Length = 300)
    $flat = ($Text -replace '\s+', ' ').Trim()
    if ($flat.Length -le $Length) { return $flat }
    return $flat.Substring(0, $Length) + '…'
}

function Test-HostTestSummary {
    <#
      宿主单测判定：exit 0、总计 > 0、失败 = 0、通过 > 0、跳过 = 0。
      TRX Counters 优先（notExecuted 即 skipped；TRX 里 NotExecuted 的结果名会附在 Reason）；
      没有 TRX 时从控制台输出解析「失败/通过/总计/跳过」或「Failed/Passed/Total/Skipped」。
      关键修复：total=0（零测试）与 skipped>0 都必须 FAIL，不能因为「失败 0」就放行。
    #>
    param(
        [int]$ExitCode,
        [string]$Text,
        $Failed = $null,
        $Passed = $null,
        $Total = $null,
        $NotExecuted = $null
    )
    $result = [pscustomobject]@{
        Ok = $false; Reason = ''; Failed = $Failed; Passed = $Passed; Total = $Total
        NotExecuted = $NotExecuted; Source = ''
    }
    if ($ExitCode -ne 0) {
        $result.Reason = "dotnet test exit $ExitCode"
        return $result
    }
    if ($null -eq $Total) {
        $failedMatch = [regex]::Match($Text, '(?:失败|Failed):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $passedMatch = [regex]::Match($Text, '(?:通过|Passed):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $totalMatch = [regex]::Match($Text, '(?:总计|Total):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $skipMatch = [regex]::Match($Text, '(?:已跳过|跳过|Skipped):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $totalMatch.Success) {
            $result.Reason = '无法从 dotnet test 输出解析总计（total）'
            return $result
        }
        $result.Total = [int]$totalMatch.Groups[1].Value
        if ($failedMatch.Success) { $result.Failed = [int]$failedMatch.Groups[1].Value }
        if ($passedMatch.Success) { $result.Passed = [int]$passedMatch.Groups[1].Value }
        if ($skipMatch.Success) { $result.NotExecuted = [int]$skipMatch.Groups[1].Value }
        $result.Source = '控制台输出'
    } else {
        $result.Source = 'TRX'
    }
    if ($null -eq $result.Failed) {
        $result.Reason = '无法解析失败数（failed）'
        return $result
    }
    if ([int]$result.Total -le 0) {
        $result.Reason = '总计 0：没有任何测试被执行'
        return $result
    }
    if ([int]$result.Failed -gt 0) {
        $result.Reason = "失败 $($result.Failed) 项"
        return $result
    }
    $skipped = if ($null -eq $result.NotExecuted) { 0 } else { [int]$result.NotExecuted }
    if ($skipped -gt 0) {
        $result.Reason = "跳过 $skipped 项（skipped 计为未验证，默认 FAIL）"
        return $result
    }
    if (($null -ne $result.Passed) -and ([int]$result.Passed -le 0)) {
        $result.Reason = '通过 0：没有任何测试真正通过'
        return $result
    }
    $result.Ok = $true
    $result.Reason = 'ok'
    return $result
}

function Get-WebViewGroupWorkingSet {
    <#
      宿主进程拉起的 WebView2 进程组（直接子进程与全部后代）的 WorkingSet64 之和。
      父子关系用 CIM 查（只有 msedgewebview2.exe 参与），WorkingSet64 逐个用 Get-Process 读。
      信息项：不参与 PASS/FAIL；CIM 不可用时返回 0 并标记 Error，采样不中断。
    #>
    param([int]$RootProcessId)
    $ids = New-Object System.Collections.Generic.List[int]
    try {
        $webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue)
        if ($webviews.Count -eq 0) {
            return [pscustomobject]@{ Bytes = [long]0; Count = 0; Error = $false }
        }
        $childrenByParent = @{}
        foreach ($webview in $webviews) {
            $parentId = [int]$webview.ParentProcessId
            if (-not $childrenByParent.ContainsKey($parentId)) {
                $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[int]
            }
            $childrenByParent[$parentId].Add([int]$webview.ProcessId)
        }
        # 从宿主 PID 出发做 BFS：父 PID 链可能跨两层以上（browser → renderer/GPU/utility）。
        $seen = New-Object 'System.Collections.Generic.HashSet[int]'
        $queue = New-Object 'System.Collections.Generic.Queue[int]'
        $queue.Enqueue($RootProcessId)
        while ($queue.Count -gt 0) {
            $currentId = $queue.Dequeue()
            if (-not $childrenByParent.ContainsKey($currentId)) { continue }
            foreach ($childId in $childrenByParent[$currentId]) {
                if ($seen.Add($childId)) {
                    $ids.Add($childId)
                    $queue.Enqueue($childId)
                }
            }
        }
    } catch {
        return [pscustomobject]@{ Bytes = [long]0; Count = 0; Error = $true }
    }
    $bytes = [long]0
    $count = 0
    foreach ($processId in $ids) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            try {
                $bytes += [long]$process.WorkingSet64
                $count += 1
            } catch {
                # 进程在采样间隙退出：跳过该进程。
            }
        }
    }
    return [pscustomobject]@{ Bytes = $bytes; Count = $count; Error = $false }
}

function Start-WebViewSampler {
    <#
      WebView2 信息项采样器：独立 runspace，每 500 ms 做一次 CIM 查询并收集进程组 WorkingSet64，
      避免 CIM（本机约 100 ms）阻塞宿主 50 ms 采样循环。宿主退出后主循环写 StopFile 结束。
    #>
    param(
        [string]$StartFile,
        [string]$StopFile,
        [string]$ResultFile,
        [string]$ReadyFile,
        [int]$IntervalMs = 500
    )
    # ${function:...}.ToString() 只含函数体，不含 function 头；显式包一层，后台脚本才能定义该函数。
    $functionText = "function Get-WebViewGroupWorkingSet {`r`n" +
        (Get-Command -Name Get-WebViewGroupWorkingSet).Definition + "`r`n}"
    $samplerTail = @'
# 先在后台预热 CIM（首次模块加载可能较慢），写 ReadyFile 后主脚本才会启动宿主。
try { $null = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue } catch { }
try { [System.IO.File]::WriteAllText($ReadyFile, 'ready', [System.Text.UTF8Encoding]::new($false)) } catch { }
$RootProcessId = 0
while (-not (Test-Path -LiteralPath $StartFile)) {
    if (Test-Path -LiteralPath $StopFile) { break }
    Start-Sleep -Milliseconds 20
}
if (Test-Path -LiteralPath $StartFile) {
    try { $RootProcessId = [int](([System.IO.File]::ReadAllText($StartFile)).Trim()) } catch { $RootProcessId = 0 }
}
$peakBytes = [long]0
$peakCount = 0
$peakTreeBytes = [long]0
$samples = 0
$errors = 0
$treeApplicable = $false
if ($RootProcessId -gt 0) {
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $root = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if (-not $root) { break }
        # I6：先读宿主 WorkingSet64 并缓存，再做 CIM 查询（CIM 约 100 ms，宿主可能在这期间退出）。
        # 宿主读不到时整树指标标「不适用」，不能用 0 冒充。
        $hostWs = [long]0
        try { $root.Refresh(); $hostWs = [long]$root.WorkingSet64 } catch { $hostWs = [long]0 }
        try {
            $group = Get-WebViewGroupWorkingSet -RootProcessId $RootProcessId
            if ($group.Error) { $errors += 1 }
            if (($group.Bytes -gt 0) -or ($group.Count -gt 0)) {
                $samples += 1
                if ($group.Bytes -gt $peakBytes) {
                    $peakBytes = [long]$group.Bytes
                    $peakCount = [int]$group.Count
                }
                if ($hostWs -gt 0) {
                    $treeApplicable = $true
                    $treeBytes = $hostWs + [long]$group.Bytes
                    if ($treeBytes -gt $peakTreeBytes) { $peakTreeBytes = $treeBytes }
                }
            }
        } catch {
            $errors += 1
        }
        Start-Sleep -Milliseconds $IntervalMs
    }
}
[pscustomobject]@{
    Bytes = [long]$peakBytes
    Count = [int]$peakCount
    TreeBytes = [long]$peakTreeBytes
    TreeApplicable = [bool]$treeApplicable
    Samples = [int]$samples
    Error = ($errors -gt 0)
} | ConvertTo-Json -Compress | ForEach-Object {
    [System.IO.File]::WriteAllText($ResultFile, $_, [System.Text.UTF8Encoding]::new($false))
}
'@
    $body = "param(`$StartFile, `$StopFile, `$ResultFile, `$ReadyFile, `$IntervalMs)`r`n" + $functionText + "`r`n" + $samplerTail
    $shell = [powershell]::Create()
    $null = $shell.AddScript($body).AddArgument($StartFile).AddArgument($StopFile).AddArgument($ResultFile).AddArgument($ReadyFile).AddArgument($IntervalMs)
    $handle = $shell.BeginInvoke()
    return [pscustomobject]@{ Shell = $shell; Handle = $handle; ResultFile = $ResultFile }
}

function Receive-WebViewSampler {
    param($Sampler, [int]$TimeoutMs = 20000)
    $empty = [pscustomobject]@{
        Bytes = [long]0; Count = 0; TreeBytes = [long]0; TreeApplicable = $false; Samples = 0; Error = $true
    }
    if (-not $Sampler) { return $empty }
    try {
        $finished = $Sampler.Handle.AsyncWaitHandle.WaitOne($TimeoutMs)
        if (-not $finished) {
            try { $Sampler.Shell.Stop() } catch { }
            return $empty
        }
        # 结果由后台脚本写入 JSON 文件再读回；不依赖 EndInvoke 的输出流（避免混入其它对象）。
        try { $null = $Sampler.Shell.EndInvoke($Sampler.Handle) } catch { }
        $json = Read-Utf8File $Sampler.ResultFile
        if (-not [string]::IsNullOrWhiteSpace($json)) {
            try {
                $parsed = $json | ConvertFrom-Json
                if ($null -ne $parsed -and $parsed.PSObject.Properties['Bytes']) { return $parsed }
            } catch {
                # JSON 损坏：按空结果处理。
            }
        }
        return $empty
    } catch {
        return $empty
    } finally {
        try { $Sampler.Shell.Dispose() } catch { }
    }
}

function Register-TrackedProcess {
    <#
      I8：进程启动时记录 (PID, StartTime, ImagePath)。清理前用同一快照校验，
      防止短时间内 PID 被系统复用后杀到用户自己的进程。
    #>
    param($Process, [string]$ExpectedPath)
    if ($null -eq $Process) { return }
    try {
        $snapshot = [pscustomobject]@{
            Pid           = [int]$Process.Id
            StartTime     = $null
            StartTimeText = ''
            Path          = ''
            ExpectedPath  = [string]$ExpectedPath
        }
        try {
            $snapshot.StartTime = $Process.StartTime
            $snapshot.StartTimeText = $Process.StartTime.ToUniversalTime().ToString('o')
        } catch {
            $snapshot.StartTime = $null
        }
        try { $snapshot.Path = [string]$Process.Path } catch { $snapshot.Path = '' }
        $script:TrackedProcesses[[int]$Process.Id] = $snapshot
        $null = $script:OurAppPids.Add([int]$Process.Id)
    } catch {
        $script:CleanupNotes.Add("记录进程快照失败 PID=$($Process.Id)：$($_.Exception.Message)")
    }
}

function New-ProcessSnapshot {
    # 立即读取一个进程的 (PID, StartTime, ImagePath) 快照；只用于杀进程前校验后代身份。
    param([int]$ProcessId)
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $snapshot = [pscustomobject]@{
        Pid = [int]$ProcessId; StartTime = $null; StartTimeText = ''; Path = ''; ExpectedPath = ''
    }
    try {
        $snapshot.StartTime = $process.StartTime
        $snapshot.StartTimeText = $process.StartTime.ToUniversalTime().ToString('o')
    } catch {
        $snapshot.StartTime = $null
    }
    try { $snapshot.Path = [string]$process.Path } catch { $snapshot.Path = '' }
    return $snapshot
}

function Test-ProcessSnapshot {
    # PID 仍存在，且 StartTime（±1 s）与 ImagePath 与快照一致才算「还是同一个进程」。
    param($Snapshot)
    if ($null -eq $Snapshot) { return $false }
    $process = Get-Process -Id ([int]$Snapshot.Pid) -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try {
        if ($null -ne $Snapshot.StartTime) {
            $delta = [Math]::Abs(($process.StartTime - $Snapshot.StartTime).TotalSeconds)
            if ($delta -gt 1) { return $false }
        }
        if ($Snapshot.ExpectedPath) {
            $currentPath = [string]$process.Path
            if ($currentPath -and (-not [string]::Equals(
                        $currentPath, [string]$Snapshot.ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase))) {
                return $false
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Stop-ProcessTree {
    <#
      从给定根 PID 出发 BFS 收集全部后代（含 WebView2 各层），按深度从深到浅停止。
      I8：每个 PID 在真正 Stop 前校验「仍存在 + StartTime 与 ImagePath 匹配」：
      根进程用启动时登记的快照，后代用收集时刻的快照；不匹配就跳过并记录（防 PID 复用杀错）。
    #>
    param([int[]]$RootIds, [int]$WaitMs = 3000)
    if ($null -eq $RootIds -or $RootIds.Count -eq 0) { return }
    $depthById = @{}
    $childrenByParent = @{}
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        foreach ($item in $all) {
            $parentId = [int]$item.ParentProcessId
            if (-not $childrenByParent.ContainsKey($parentId)) {
                $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[int]
            }
            $childrenByParent[$parentId].Add([int]$item.ProcessId)
        }
    } catch {
        # CIM 不可用：退化为只停根 PID（下面的 exe 路径兜底仍会执行）。
    }
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($rootId in $RootIds) {
        if (-not $depthById.ContainsKey($rootId)) {
            $depthById[$rootId] = 0
            $queue.Enqueue($rootId)
        }
    }
    while ($queue.Count -gt 0) {
        $currentId = $queue.Dequeue()
        if (-not $childrenByParent.ContainsKey($currentId)) { continue }
        foreach ($childId in $childrenByParent[$currentId]) {
            if (-not $depthById.ContainsKey($childId)) {
                $depthById[$childId] = [int]$depthById[$currentId] + 1
                $queue.Enqueue($childId)
            }
        }
    }
    $ordered = @($depthById.Keys | Sort-Object { $depthById[$_] } -Descending)

    # 为后代抓取「收集时刻」快照；根进程优先使用启动时登记的快照（最长生命周期的身份依据）。
    $snapshots = @{}
    foreach ($processId in $ordered) {
        if ($TrackedProcesses.ContainsKey([int]$processId)) {
            $snapshots[[int]$processId] = $TrackedProcesses[[int]$processId]
        } else {
            $snapshots[[int]$processId] = New-ProcessSnapshot -ProcessId ([int]$processId)
        }
    }

    $stopped = 0
    $skipped = 0
    foreach ($processId in $ordered) {
        $snapshot = $snapshots[[int]$processId]
        if ($null -eq $snapshot) {
            $skipped += 1
            continue
        }
        if (-not (Test-ProcessSnapshot $snapshot)) {
            $skipped += 1
            # 正常退出的进程不写报告噪音；PID 仍存在但身份不匹配才提示（疑似复用，已跳过）。
            if (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue) {
                $script:CleanupNotes.Add("跳过 PID $processId：StartTime/ImagePath 与快照不匹配（疑似 PID 复用）")
            }
            continue
        }
        try {
            Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
            $stopped += 1
        } catch {
            $skipped += 1
        }
    }
    if ($stopped -gt 0) {
        $script:CleanupNotes.Add("已停止 $stopped 个进程（含 WebView2 后代）；校验跳过 $skipped 个")
    }
    if ($WaitMs -gt 0) {
        $deadline = (Get-Date).AddMilliseconds($WaitMs)
        while ((Get-Date) -lt $deadline) {
            $alive = 0
            foreach ($processId in $ordered) {
                if (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue) { $alive += 1 }
            }
            if ($alive -eq 0) { break }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Stop-WebViewDescendants {
    <#
      按父 PID 停止 WebView2 进程组（直接子进程与全部后代）。
      修复波 D：5 万行超时重试前必须清掉残留的 msedgewebview2，否则它们可能持有临时 profile、
      让第二次启动复用半初始化环境（也可能被后续单实例检查误认为宿主进程）。
      只处理 Name=msedgewebview2.exe 的进程；CIM 不可用时不阻塞重试。
    #>
    param([int]$RootProcessId)
    if ($RootProcessId -le 0) { return 0 }
    $stopped = 0
    try {
        $webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue)
        if ($webviews.Count -eq 0) { return 0 }
        $childrenByParent = @{}
        foreach ($item in $webviews) {
            $parentId = [int]$item.ParentProcessId
            if (-not $childrenByParent.ContainsKey($parentId)) {
                $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[int]
            }
            $childrenByParent[$parentId].Add([int]$item.ProcessId)
        }
        $seen = New-Object 'System.Collections.Generic.HashSet[int]'
        $queue = New-Object System.Collections.Generic.Queue[int]
        $queue.Enqueue($RootProcessId)
        while ($queue.Count -gt 0) {
            $currentId = $queue.Dequeue()
            if (-not $childrenByParent.ContainsKey($currentId)) { continue }
            foreach ($childId in $childrenByParent[$currentId]) {
                if ($seen.Add($childId)) {
                    $queue.Enqueue($childId)
                }
            }
        }
        foreach ($processId in $seen) {
            try {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                $stopped += 1
            } catch {
                # 进程已在收集与停止之间退出：跳过。
            }
        }
    } catch {
        # CIM 不可用：重试继续，由 profile 清理与下一次启动自行恢复。
    }
    return $stopped
}

function Clear-WebViewProfile {
    <#
      修复波 D：重试前清理临时 WebView2 profile 子目录（<JJ_DATA_DIR>\WebView2）。
      只接受本次验收的隔离数据目录（调用方保证），失败重试若干次后放弃，不阻塞验收。
    #>
    param([string]$DataDir)
    if ([string]::IsNullOrWhiteSpace($DataDir)) { return }
    $profile = Join-Path $DataDir 'WebView2'
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            if (-not (Test-Path -LiteralPath $profile)) { return }
            Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction Stop
            return
        } catch {
            Start-Sleep -Milliseconds 200
        }
    }
}

function Stop-OurProcesses {
    <#
      只清理本次启动的宿主及其后代：根 PID 来自 $OurAppPids，另加「可执行文件路径等于本次副本 exe」
      的兜底（绝不碰用户其它实例）。每次 Stop 前都用 (PID, StartTime, ImagePath) 快照校验。
    #>
    $roots = New-Object System.Collections.Generic.List[int]
    foreach ($processId in $OurAppPids) {
        $snapshot = $TrackedProcesses[[int]$processId]
        if ($null -eq $snapshot) {
            continue
        }
        if (-not (Test-ProcessSnapshot $snapshot)) {
            # 已正常退出不记噪音；PID 仍存在但身份不匹配才值得写报告（疑似复用，已跳过）。
            if (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue) {
                $script:CleanupNotes.Add("跳过根 PID $processId：StartTime/ImagePath 与启动快照不匹配")
            }
            continue
        }
        if ($roots -notcontains [int]$processId) {
            $roots.Add([int]$processId)
        }
    }
    if ($Exe) {
        foreach ($process in @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)) {
            try {
                if ($process.Path -and ($process.Path -eq $Exe)) {
                    Register-TrackedProcess -Process $process -ExpectedPath $Exe
                    if ($roots -notcontains [int]$process.Id) {
                        $roots.Add([int]$process.Id)
                    }
                }
            } catch {
                # 进程刚退出/无权限读路径：跳过。
            }
        }
    }
    if ($roots.Count -gt 0) {
        Stop-ProcessTree -RootIds $roots.ToArray() -WaitMs 3000
    }
    if ($Exe) {
        $leftover = @()
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $leftover = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue | Where-Object {
                    try { $_.Path -eq $Exe } catch { $false }
                })
            if ($leftover.Count -eq 0) { break }
            Start-Sleep -Milliseconds 100
        }
        if ($leftover.Count -gt 0) {
            $leftoverIds = (($leftover | ForEach-Object { $_.Id }) -join ', ')
            $script:CleanupNotes.Add("残留 $($leftover.Count) 个副本进程（PID：$leftoverIds）")
            Write-Host "[WARN] 验收后仍有 $($leftover.Count) 个副本进程残留（PID：$leftoverIds）" -ForegroundColor Yellow
        } else {
            $script:CleanupNotes.Add('残留检查：无本次副本进程残留')
        }
    }
}

function Invoke-SelfTestChecks {
    <#
      验收脚本自测（I8 的反假通过补充）：给纯函数喂固定样本，验证它们真的会拒绝坏输入。
      返回 [{Name, Pass, Detail}]；-SelfTest 逐例打印，正常验收在第 0 步汇总为一项。
    #>
    $cases = New-Object System.Collections.Generic.List[object]
    $add = {
        param([string]$Name, [bool]$Pass, [string]$Detail)
        $cases.Add([pscustomobject]@{ Name = $Name; Pass = $Pass; Detail = $Detail })
    }

    $expectedPath = 'C:\tmp\a.md'
    $validReady = '{"ready":true,"path":"C:\\tmp\\a.md","elapsedMs":120,"tocCount":38}'
    $readyCheck = Test-ReadyPayload -RawJson $validReady -ExpectedPath $expectedPath `
        -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：合法样本通过' ($readyCheck.Ok -and $readyCheck.ElapsedMs -eq 120 -and $readyCheck.TocCount -eq 38) $readyCheck.Reason

    $stringReady = Test-ReadyPayload -RawJson '{"ready":"true","path":"C:\\tmp\\a.md","elapsedMs":100,"tocCount":38}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：ready 为字符串 "true" 必须拒绝' (-not $stringReady.Ok) $stringReady.Reason

    $missingPath = Test-ReadyPayload -RawJson '{"ready":true,"elapsedMs":100,"tocCount":38}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：缺少 path 必须拒绝' (-not $missingPath.Ok) $missingPath.Reason

    $mismatchPath = Test-ReadyPayload -RawJson '{"ready":true,"path":"C:\\tmp\\b.md","elapsedMs":100,"tocCount":38}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：path 与传入文件不一致必须拒绝' (-not $mismatchPath.Ok) $mismatchPath.Reason

    $overElapsed = Test-ReadyPayload -RawJson '{"ready":true,"path":"C:\\tmp\\a.md","elapsedMs":1500,"tocCount":38}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：elapsedMs 超上限必须拒绝' (-not $overElapsed.Ok) $overElapsed.Reason

    $lowToc = Test-ReadyPayload -RawJson '{"ready":true,"path":"C:\\tmp\\a.md","elapsedMs":100,"tocCount":30}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：tocCount 低于下限必须拒绝' (-not $lowToc.Ok) $lowToc.Reason

    $highToc = Test-ReadyPayload -RawJson '{"ready":true,"path":"C:\\tmp\\a.md","elapsedMs":100,"tocCount":45}' `
        -ExpectedPath $expectedPath -MaxElapsedMs 1000 -MinTocCount 36 -MaxTocCount 40
    & $add 'READY：tocCount 高于上限必须拒绝' (-not $highToc.Ok) $highToc.Reason

    $goodHost = Test-HostTestSummary -ExitCode 0 -Text '' -Failed 0 -Passed 10 -Total 10 -NotExecuted 0
    & $add '宿主汇总：全绿通过' ($goodHost.Ok) $goodHost.Reason

    $zeroTotal = Test-HostTestSummary -ExitCode 0 -Text '' -Failed 0 -Passed 0 -Total 0 -NotExecuted 0
    & $add '宿主汇总：总计 0 必须拒绝' (-not $zeroTotal.Ok -and $zeroTotal.Reason -match '总计 0') $zeroTotal.Reason

    $zeroPassed = Test-HostTestSummary -ExitCode 0 -Text '' -Failed 0 -Passed 0 -Total 10 -NotExecuted 0
    & $add '宿主汇总：通过 0 必须拒绝' (-not $zeroPassed.Ok -and $zeroPassed.Reason -match '通过 0') $zeroPassed.Reason

    $skippedHost = Test-HostTestSummary -ExitCode 0 -Text '' -Failed 0 -Passed 9 -Total 10 -NotExecuted 1
    & $add '宿主汇总：skipped > 0 必须拒绝' (-not $skippedHost.Ok -and $skippedHost.Reason -match '跳过') $skippedHost.Reason

    $failedHost = Test-HostTestSummary -ExitCode 0 -Text '' -Failed 1 -Passed 9 -Total 10 -NotExecuted 0
    & $add '宿主汇总：failed > 0 必须拒绝' (-not $failedHost.Ok -and $failedHost.Reason -match '失败') $failedHost.Reason

    $pdfText = 'PDF-READY {"ready":true,"input":"C:\\tmp\\a.md","output":"C:\\tmp\\a.pdf","bytes":7000,"elapsedMs":900}'
    $pdfReady = Find-PdfReadyJson $pdfText
    & $add 'PDF-READY：合法行解析出对象' ($null -ne $pdfReady -and [long]$pdfReady.bytes -eq 7000) '解析成功'
    & $add 'PDF-READY：缺失行返回 null' ($null -eq (Find-PdfReadyJson 'nothing here')) '未匹配'
    & $add 'PDF-READY：JSON 损坏返回 null' ($null -eq (Find-PdfReadyJson 'PDF-READY {broken}')) '解析失败按 null 处理'

    $readyLine = Find-ReadyJson "noise`nREADY {`"ready`":true,`"path`":`"x`"}`n"
    & $add 'READY 行：提取原始 JSON' ($null -ne $readyLine -and $readyLine -match '"ready":true') $readyLine
    & $add 'READY 行：缺失返回 null' ($null -eq (Find-ReadyJson 'no ready line')) '未匹配'

    & $add '路径比较：大小写/斜杠差异视为相同' (Test-PathEqualForVerify -Actual 'c:/tmp/A.MD' -Expected 'C:\tmp\a.md') '归一化'
    & $add '路径比较：不同文件视为不同' (-not (Test-PathEqualForVerify -Actual 'C:\tmp\b.md' -Expected 'C:\tmp\a.md')) '不同路径'

    & $add 'ASCII 判定：纯 ASCII=true' (Test-AsciiOnly 'C:\temp\jj-verify-1') '纯 ASCII'
    & $add 'ASCII 判定：中文路径=false' (-not (Test-AsciiOnly 'D:\资料\jj')) '含非 ASCII'

    return $cases
}

# ── 验收脚本自测模式：不构建、不运行产品 ─────────────────────────────────────

if ($SelfTest) {
    Write-Host '鲸鲸阅读器验收脚本自测（-SelfTest）'
    $selfTestCases = Invoke-SelfTestChecks
    $selfTestFailures = 0
    foreach ($case in $selfTestCases) {
        $status = if ($case.Pass) { 'PASS' } else { 'FAIL' }
        $color = if ($case.Pass) { 'Green' } else { 'Red' }
        Write-Host "[$status] $($case.Name)：$($case.Detail)" -ForegroundColor $color
        if (-not $case.Pass) { $selfTestFailures += 1 }
    }
    Write-Host ''
    # 修复波 D：不仅要求 0 失败，还要求固定样本总数恰为 21（用例被删/漏注册同样 FAIL）。
    $selfTestOk = ($selfTestFailures -eq 0) -and ($selfTestCases.Count -eq $ExpectedSelfTestCases)
    if (-not $selfTestOk) {
        Write-Host "SELFTEST FAILED（$selfTestFailures 例失败；期望 $ExpectedSelfTestCases 例，实际 $($selfTestCases.Count) 例）" -ForegroundColor Red
        exit 1
    }
    Write-Host "SELFTEST OK（$($selfTestCases.Count) 例全部通过）" -ForegroundColor Green
    exit 0
}

# ── 预检：目录/工具链存在 ─────────────────────────────────────────────────────

$tempRootInfo = Resolve-AsciiTempRoot
if (-not $tempRootInfo.Root) {
    Write-Host ''
    Write-Host 'VERIFY FAILED（无法准备纯 ASCII 临时目录）' -ForegroundColor Red
    Write-Host "原因：$($tempRootInfo.Reason)"
    if ($tempRootInfo.Attempts) { Write-Host "尝试记录：$($tempRootInfo.Attempts)" }
    Write-Host '请检查 %TEMP%/%LOCALAPPDATA% 权限，或手动在脚本所在盘根目录创建目录后重试。'
    exit 1
}
$TempRoot = $tempRootInfo.Root
$TempRootSource = $tempRootInfo.Source
$TempRootReason = $tempRootInfo.Reason
$null = [System.IO.Directory]::CreateDirectory((Join-Path $TempRoot 'pdf'))

# I2 隔离：数据目录与 WebView2 profile 都放在 ASCII 临时目录下，并显式传给每个 exe 调用。
$JjDataDir = Join-Path $TempRoot 'appdata'
$null = [System.IO.Directory]::CreateDirectory($JjDataDir)
$AppEnv = @{ JJ_DATA_DIR = $JjDataDir }
# 修复波 D：保存调用方原有的 JJ_DATA_DIR（存在性 + 值），finally 原样恢复，避免污染后续命令。
$PreviousJjDataDirExists = Test-Path Env:JJ_DATA_DIR
$PreviousJjDataDir = $env:JJ_DATA_DIR
# 让 dotnet test / npm test 等子进程也继承隔离变量（DebugLog 等测试辅助不会写用户 %APPDATA%）。
$env:JJ_DATA_DIR = $JjDataDir
# 验收前后比对用户真实 recent.json：隔离失效时这一项必须暴露出来。
$AppDataRecentBefore = Get-FileState $AppDataRecentPath

$PSHost = $null
try {
    $PSHost = (Get-Process -Id $PID).Path
} catch {
    $PSHost = $null
}
if (-not $PSHost) {
    $PSHost = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $PSHost)) {
        $PSHost = Join-Path $PSHOME 'powershell.exe'
    }
}

Write-Host '鲸鲸阅读器验收（scripts/verify.ps1）'
Write-Host "PowerShell：$($PSVersionTable.PSVersion)（$($PSVersionTable.PSEdition)）"
Write-Host "仓库：$Root"
Write-Host "临时目录：$TempRoot（$TempRootReason）"
Write-Host "数据隔离：JJ_DATA_DIR=$JjDataDir（settings/recent/positions/debug.log 与 WebView2 profile）"
if ($tempRootInfo.Attempts) {
    Write-Host "临时目录回退记录：$($tempRootInfo.Attempts)"
}
Write-Host ''

try {
    # ── ⓪ 验收脚本自测（第 0 步；不构建/不启动产品）──────────────────────────
    Write-Host '[0/13] 验收脚本自测（-SelfTest 纯函数样本）…'
    $scriptCases = Invoke-SelfTestChecks
    $scriptCaseFailures = @($scriptCases | Where-Object { -not $_.Pass })
    # 修复波 D：正常验收同样锁定固定样本总数 21（与 -SelfTest 口径一致）。
    $scriptTestOk = ($scriptCaseFailures.Count -eq 0) -and ($scriptCases.Count -eq $ExpectedSelfTestCases)
    $scriptTestActual = "$($scriptCases.Count) 例固定样本（期望 $ExpectedSelfTestCases），$($scriptCaseFailures.Count) 例失败"
    if ($scriptCaseFailures.Count -gt 0) {
        $scriptTestActual += '；失败：' + (($scriptCaseFailures | ForEach-Object { $_.Name }) -join '、')
    } elseif ($scriptCases.Count -ne $ExpectedSelfTestCases) {
        $scriptTestActual += "；样本总数不是 $ExpectedSelfTestCases（用例被删/漏注册）"
    }
    Add-Result -Name '验收脚本自测' -Expect 'Test-ReadyPayload / Test-HostTestSummary / Find-PdfReadyJson 等固定样本全部 PASS' `
        -Actual $scriptTestActual -Pass $scriptTestOk

    # ── ① 构建 ───────────────────────────────────────────────────────────────
    Write-Host '[1/13] 构建（scripts/build.ps1）…'
    $buildOk = $false
    $buildActual = ''
    if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
        $buildActual = '缺少 scripts/build.ps1'
    } else {
        $build = Invoke-Captured -FilePath $PSHost -WorkingDirectory $Root -TimeoutMs 900000 `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $BuildScript)
        $buildTail = Get-ShortText (($build.StdOut.Trim() -split "`r?`n" | Select-Object -Last 3) -join ' | ') 400
        if ($build.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $OutDir 'JingjingReader.exe') -PathType Leaf)) {
            $buildOk = $true
            $buildActual = 'exit 0；' + $buildTail
        } else {
            $buildActual = "exit $($build.ExitCode)（超时=$($build.TimedOut)）；" + $buildTail
            if ($build.StdErr) {
                $buildActual += '；stderr：' + (Get-ShortText $build.StdErr 300)
            }
        }
    }
    Add-Result -Name '构建' -Expect 'scripts/build.ps1 exit 0，产出 out\JingjingReader.exe' -Actual $buildActual -Pass $buildOk

    # ── ② 宿主单测 ───────────────────────────────────────────────────────────
    Write-Host '[2/13] 宿主单测（dotnet test）…'
    $hostTestOk = $false
    $hostTestActual = ''
    $dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)
    if (-not $dotnet) {
        $hostTestActual = '未找到 dotnet'
    } elseif (-not (Test-Path -LiteralPath $TestProject -PathType Leaf)) {
        $hostTestActual = "缺少测试项目：$TestProject"
    } else {
        $trxPath = Join-Path $TempRoot 'host-tests.trx'
        $dotnetTest = Invoke-Captured -FilePath $dotnet.Source -WorkingDirectory $Root -TimeoutMs 900000 `
            -Arguments @('test', $TestProject, '-c', 'Debug', '--nologo', '--logger', 'trx;LogFileName=host-tests.trx', '--results-directory', $TempRoot)
        $hostText = $dotnetTest.StdOut + "`n" + $dotnetTest.StdErr
        $failedCount = $null
        $passedCount = $null
        $totalCount = $null
        $notExecutedCount = $null
        $skippedNames = @()
        if (Test-Path -LiteralPath $trxPath -PathType Leaf) {
            try {
                [xml]$trx = Get-Content -LiteralPath $trxPath -Raw -Encoding UTF8
                $counters = @($trx.GetElementsByTagName('Counters') | Select-Object -First 1)
                if ($counters.Count -gt 0) {
                    $failedCount = [int]$counters[0].GetAttribute('failed')
                    $passedCount = [int]$counters[0].GetAttribute('passed')
                    $totalCount = [int]$counters[0].GetAttribute('total')
                    $notExecutedCount = [int]$counters[0].GetAttribute('notExecuted')
                }
                # I5：列出被跳过的测试名（TRX outcome=NotExecuted），skipped > 0 默认 FAIL。
                $skippedNames = @($trx.GetElementsByTagName('UnitTestResult') | Where-Object {
                        $_.GetAttribute('outcome') -eq 'NotExecuted'
                    } | ForEach-Object { $_.GetAttribute('testName') })
            } catch {
                $failedCount = $null
            }
        }
        $hostCheck = Test-HostTestSummary -ExitCode $dotnetTest.ExitCode -Text $hostText `
            -Failed $failedCount -Passed $passedCount -Total $totalCount -NotExecuted $notExecutedCount
        $hostTestOk = $hostCheck.Ok
        if ($null -ne $totalCount) {
            $hostTestActual = "失败 $failedCount / 通过 $passedCount / 总计 $totalCount / 跳过 $notExecutedCount（$($hostCheck.Source)）"
            if ($skippedNames.Count -gt 0) {
                $hostTestActual += '；跳过项：' + (($skippedNames | Select-Object -First 5) -join '、')
                if ($skippedNames.Count -gt 5) { $hostTestActual += " 等 $($skippedNames.Count) 项" }
            }
        } else {
            $hostTestActual = "exit $($dotnetTest.ExitCode)；" + (Get-ShortText (($hostText -split "`r?`n" | Where-Object { $_ -match '通过|Passed|失败|Failed|总计|Total|跳过|Skipped' } | Select-Object -Last 3) -join ' | ') 300)
        }
        if (-not $hostTestOk) {
            $hostTestActual += "；原因：$($hostCheck.Reason)"
        }
        if (-not $hostTestOk -and $dotnetTest.TimedOut) {
            $hostTestActual = '测试超时（> 15 分钟）'
        }
    }
    Add-Result -Name '宿主单测' -Expect 'dotnet test 全绿（总计 > 0、失败 0、跳过 0）' -Actual $hostTestActual -Pass $hostTestOk

    # ── ③ 前端单测 ───────────────────────────────────────────────────────────
    Write-Host '[3/13] 前端单测（cd web; npm test）…'
    $webTestOk = $false
    $webTestActual = ''
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
    }
    if (-not $npm) {
        $webTestActual = '未找到 npm'
    } elseif (-not (Test-Path -LiteralPath (Join-Path $WebDir 'package.json') -PathType Leaf)) {
        $webTestActual = '缺少 web/package.json'
    } else {
        $webTest = Invoke-Captured -FilePath $npm.Source -WorkingDirectory $WebDir -TimeoutMs 600000 `
            -Arguments @('test')
        $webText = $webTest.StdOut + "`n" + $webTest.StdErr
        $testFilesText = Get-MatchValue $webText 'Test Files\s+(\d+)\s+passed'
        $testCountText = Get-MatchValue $webText 'Tests\s+(\d+)\s+passed'
        $skippedText = Get-MatchValue $webText 'Tests\s+.*?(\d+)\s+skipped'
        $testFilesValue = 0
        $testCountValue = 0
        $skippedValue = 0
        $parsedFiles = [int]::TryParse($testFilesText, [ref]$testFilesValue)
        $parsedTests = [int]::TryParse($testCountText, [ref]$testCountValue)
        $parsedSkipped = [int]::TryParse($skippedText, [ref]$skippedValue)
        $hasFailedSummary = ($webText -match 'Tests\s+\d+\s+failed')
        # 零测试不能算通过：Test Files 与 Tests 都必须 > 0；I5：skipped > 0 也默认 FAIL。
        $webTestOk = ($webTest.ExitCode -eq 0) -and $parsedFiles -and $parsedTests -and
            ($testFilesValue -gt 0) -and ($testCountValue -gt 0) -and (-not $hasFailedSummary) -and
            ($skippedValue -eq 0)
        $webTestActual = "exit $($webTest.ExitCode)；Test Files $testFilesValue passed / Tests $testCountValue passed"
        if ($parsedSkipped) {
            $webTestActual += " / Tests $skippedValue skipped"
        }
        if ($skippedValue -gt 0) {
            $skippedLines = @($webText -split "`r?`n" | Where-Object { $_ -match '↓|\bskipped\b' } | Select-Object -First 5)
            if ($skippedLines.Count -gt 0) {
                $webTestActual += '；跳过项：' + (Get-ShortText (($skippedLines -join ' | ')) 300)
            }
        }
        if (-not $webTestOk) {
            $failReason = if (-not $parsedFiles -or -not $parsedTests) {
                '无法解析 Test Files/Tests 通过数'
            } elseif ($testFilesValue -le 0 -or $testCountValue -le 0) {
                'Test Files 或 Tests 为 0（零测试不能通过）'
            } elseif ($hasFailedSummary) {
                '存在 failed 用例'
            } elseif ($skippedValue -gt 0) {
                "${skippedValue} 个用例被跳过（skipped 计为未验证，默认 FAIL）"
            } else {
                "exit $($webTest.ExitCode)"
            }
            $webTestActual += "；原因：$failReason；" + (Get-ShortText (($webText -split "`r?`n" | Where-Object { $_ -match 'FAIL|failed|Error' } | Select-Object -Last 3) -join ' | ') 300)
        }
    }
    Add-Result -Name '前端单测' -Expect 'web/npm test 全绿（Test Files > 0、Tests > 0、跳过 0）' -Actual $webTestActual -Pass $webTestOk

    # ── ④ 复制 out 到 ASCII 临时目录 ─────────────────────────────────────────
    Write-Host '[4/13] 复制 out\ 到 ASCII 临时目录…'
    $copyOk = $false
    $copyActual = ''
    try {
        $sourceExe = Join-Path $OutDir 'JingjingReader.exe'
        if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
            $copyActual = "缺少 $sourceExe"
        } else {
            Copy-Item -Path (Join-Path $OutDir '*') -Destination $TempRoot -Recurse -Force
            $Exe = Join-Path $TempRoot 'JingjingReader.exe'
            foreach ($sample in @('hello.md', 'full-syntax.md', 'huge-50k-lines.md')) {
                $sourceSample = Join-Path $SamplesDir $sample
                if (-not (Test-Path -LiteralPath $sourceSample -PathType Leaf)) {
                    throw "缺少样例：$sourceSample"
                }
                Copy-Item -LiteralPath $sourceSample -Destination (Join-Path $TempRoot $sample) -Force
            }
            $copyOk = Test-Path -LiteralPath $Exe -PathType Leaf
            $copyActual = "副本 $Exe（$(Format-Mb (Get-Item -LiteralPath $Exe).Length)）；数据目录 $JjDataDir"
        }
    } catch {
        $copyActual = '复制失败：' + $_.Exception.Message
    }
    Add-Result -Name 'ASCII 运行副本' -Expect 'out\ 完整复制到纯 ASCII 临时目录（%TEMP% 或回退目录）' -Actual $copyActual -Pass $copyOk

    # ── ⑤ 分发包完整性（I1）────────────────────────────────────────────────────
    Write-Host '[5/13] 分发包完整性…'
    $packageOk = $false
    $packageActual = ''
    $packageFiles = @('JingjingReader.exe', 'install.ps1', 'uninstall.ps1', 'README.md')
    $missingFiles = @()
    foreach ($file in $packageFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $OutDir $file) -PathType Leaf)) {
            $missingFiles += $file
        }
    }
    $packageOk = ($missingFiles.Count -eq 0)
    $packageActual = if ($packageOk) {
        "out\ 含 $($packageFiles -join ' + ')"
    } else {
        "out\ 缺少：$($missingFiles -join '、')（检查 scripts/build.ps1 的分发拷贝）"
    }
    Add-Result -Name '分发包完整性' -Expect 'out\ 内 exe + install.ps1 + uninstall.ps1 + README.md 均存在' `
        -Actual $packageActual -Pass $packageOk

    # 后续启动实测都依赖副本 exe；缺失时明确跳过并给 FAIL 行，不让脚本抛异常中断。
    $canRunHost = $copyOk

    # ── ⑥ 环境自检 ───────────────────────────────────────────────────────────
    Write-Host '[6/13] 环境自检（--selftest）…'
    $selftestOk = $false
    $selftestActual = ''
    if (-not $canRunHost) {
        $selftestActual = '跳过：运行副本缺失'
    } else {
        $selftestProbe = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 60000 `
            -Arguments @('--selftest') -Environment $AppEnv
        $SelftestText = $selftestProbe.StdOut
        $productLine = Get-MatchValue $SelftestText '产品名:\s*(.+)'
        $selftestOk = ($selftestProbe.ExitCode -eq 0) -and ($SelftestText -match '产品名:\s*鲸鲸阅读器')
        $selftestActual = "exit $($selftestProbe.ExitCode)；产品名=$productLine；数据目录=$JjDataDir"
        if (-not $selftestOk) {
            $selftestActual += '；' + (Get-ShortText ($selftestProbe.StdOut + ' ' + $selftestProbe.StdErr) 300)
        }
    }
    Add-Result -Name '环境自检' -Expect 'exit 0 且 stdout 含「产品名: 鲸鲸阅读器」' -Actual $selftestActual -Pass $selftestOk

    # ── ⑥ full-syntax 首屏 + ⑧ 端到端首屏 ─────────────────────────────────────
    Write-Host '[7/13] full-syntax 首屏与端到端墙钟（--verify-render）…'
    $fullOk = $false
    $fullActual = ''
    $fullElapsed = $null
    $fullToc = $null
    $fullFirstReadyMs = $null
    if (-not $canRunHost) {
        $fullActual = '跳过：运行副本缺失'
    } else {
        $fullFilePath = Join-Path $TempRoot 'full-syntax.md'
        # 端到端口径：Process.Start → stdout READY；同一进程的 stdout 也用于 READY 严格校验。
        $renderFull = Invoke-CapturedFirstReady -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 60000 `
            -Arguments @('--verify-render', $fullFilePath) -Environment $AppEnv
        $fullFirstReadyMs = $renderFull.FirstReadyMs
        $fullRawReady = Find-ReadyJson $renderFull.StdOut
        if ($null -ne $fullRawReady) {
            $fullCheck = Test-ReadyPayload -RawJson $fullRawReady -ExpectedPath $fullFilePath `
                -MaxElapsedMs $FullElapsedLimitMs -MinTocCount $FullTocMin -MaxTocCount $FullTocMax
            $fullElapsed = $fullCheck.ElapsedMs
            $fullToc = $fullCheck.TocCount
            $fullOk = ($renderFull.ExitCode -eq 0) -and $fullCheck.Ok
            $fullActual = "elapsedMs=$fullElapsed（≤ $FullElapsedLimitMs）、tocCount=$fullToc（$FullTocMin–$FullTocMax）、exit $($renderFull.ExitCode)、ready=true、path 一致"
            if ($fullFirstReadyMs) {
                $fullActual += "、端到端 $([math]::Round($fullFirstReadyMs)) ms"
            }
            if (-not $fullOk) {
                $fullReasons = @()
                if ($renderFull.ExitCode -ne 0) { $fullReasons += "exit $($renderFull.ExitCode)（期望 0）" }
                if (-not $fullCheck.Ok) { $fullReasons += $fullCheck.Reason }
                $fullActual += '；原因：' + ($fullReasons -join '；') + "；READY 原始行：$fullRawReady"
            }
        } else {
            $fullActual = "未解析到 READY JSON；exit $($renderFull.ExitCode)；" + (Get-ShortText ($renderFull.StdOut + ' ' + $renderFull.StdErr) 300)
        }
    }
    Add-Result -Name 'full-syntax 首屏' -Expect "elapsedMs ≤ $FullElapsedLimitMs ms，tocCount ∈ [$FullTocMin, $FullTocMax]，exit 0 且 READY 字段合法" -Actual $fullActual -Pass $fullOk

    # ── ⑧ 端到端首屏（进程启动 → READY；含 WebView2 初始化/文件读取）───────────
    $e2eActual = ''
    $e2eStatus = 'FAIL'
    if (-not $canRunHost) {
        $e2eActual = '跳过：运行副本缺失'
    } elseif ($null -eq $fullFirstReadyMs) {
        $e2eActual = '未采集到 READY（端到端计时不成立）'
    } else {
        $e2eRounded = [math]::Round([double]$fullFirstReadyMs)
        $e2eActual = "Process.Start → stdout READY：$e2eRounded ms（PASS < $E2ePassMs ms；WARN ≤ $E2eWarnMs ms）；elapsedMs（渲染器口径）=$fullElapsed ms"
        if ($fullFirstReadyMs -lt $E2ePassMs) {
            $e2eStatus = 'PASS'
        } elseif ($fullFirstReadyMs -le $E2eWarnMs) {
            $e2eStatus = 'WARN'
            $e2eActual += "；spec §2.3 的 1.0 s 是设计目标，当前 CLI 冷启动含 WebView2 初始化，记 WARN 不判 FAIL"
        } else {
            $e2eStatus = 'FAIL'
            $e2eActual += "；超过 $E2eWarnMs ms 上限"
        }
    }
    Add-Result -Name '端到端首屏（含 WebView2 初始化）' -Expect "热缓存下 ≤ $E2eWarnMs ms（< $E2ePassMs ms 记 PASS，否则 WARN）；elapsedMs 为渲染器耗时，两者口径不同" `
        -Actual $e2eActual -Pass ($e2eStatus -ne 'FAIL') -Status $e2eStatus

    # ── ⑦ 5 万行首屏 + 宿主私有内存峰值（WebView2 进程组仅作信息项）──────────
    Write-Host '[8/13] 5 万行首屏与内存峰值（--verify-render + 宿主 50 ms 采样，外层超时 60 s）…'
    $hugeElapsed = $null
    $hugeToc = $null
    $hugeReadyOk = $false
    $hugeActual = ''
    $hugeAttempts = 0
    $hugeHistory = New-Object System.Collections.Generic.List[string]
    $hugeDebugTail = ''
    $peakPrivateBytes = [long]0
    $peakWebViewBytes = [long]0
    $peakWebViewCount = 0
    $peakTreeBytes = [long]0
    $treeApplicable = $false
    $memorySamples = 0
    $hostSampleMaxGapMs = 0
    $memoryOk = $false
    $memoryActual = ''
    $webViewBaselineActual = '未采集'
    $webViewResult = [pscustomobject]@{
        Bytes = [long]0; Count = 0; TreeBytes = [long]0; TreeApplicable = $false; Samples = 0; Error = $true
    }
    if (-not $canRunHost) {
        $hugeActual = '跳过：运行副本缺失'
        $memoryActual = '跳过：运行副本缺失'
    } else {
        $hugeFilePath = Join-Path $TempRoot 'huge-50k-lines.md'
        $hugeProbe = $null
        # I7：外层超时 60 s（旧 180 s 会掩盖挂起）；干净超时允许重试 1 次并记录尝试历史。
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            $hugeAttempts = $attempt
            $probe = Invoke-HugeRenderProbe -FilePath $hugeFilePath -WorkDir $TempRoot -TimeoutSeconds $HugeTimeoutSeconds
            $hugeProbe = $probe
            if ($probe.Error) {
                $hugeHistory.Add("第 $attempt 次：启动/采样异常 - $($probe.Error)")
            } else {
                $probeReady = Find-ReadyJson $probe.StdOut
                $probeElapsed = '缺失'
                if ($null -ne $probeReady) {
                    try {
                        $probeElapsed = [string](($probeReady | ConvertFrom-Json).elapsedMs)
                    } catch {
                        $probeElapsed = '解析失败'
                    }
                }
                $hugeHistory.Add(
                    "第 $attempt 次：exit=$($probe.ExitCode)，超时=$($probe.TimedOut)，elapsedMs=$probeElapsed，" +
                    "内存样本=$($probe.MemorySamples)，最大间隔=$($probe.HostSampleMaxGapMs) ms")
            }
            if ($probe.TimedOut) {
                $tail = Get-DebugLogTail (Join-Path $JjDataDir 'debug.log')
                $hugeDebugTail = $tail
                $hugeHistory.Add("第 $attempt 次超时（> $HugeTimeoutSeconds s），debug.log 尾部：$tail")
                if ($attempt -lt 2) {
                    # 修复波 D：重试前按父 PID 杀掉残留 WebView2 后代，并清理临时 profile 子目录。
                    $webViewStopped = Stop-WebViewDescendants -RootProcessId ([int]$probe.ProcessId)
                    Clear-WebViewProfile -DataDir $JjDataDir
                    $hugeHistory.Add("第 $attempt 次超时后清理：WebView2 后代 $webViewStopped 个；临时 profile <JJ_DATA_DIR>\WebView2 已清理")
                    Write-Host "[WARN] 5 万行首屏第 1 次超时（> $HugeTimeoutSeconds s），清理 WebView2 后代 $webViewStopped 个与临时 profile 后重试 1 次" -ForegroundColor Yellow
                    continue
                }
            }
            break
        }

        $peakPrivateBytes = [long]$hugeProbe.PeakPrivateBytes
        $memorySamples = [int]$hugeProbe.MemorySamples
        $hostSampleMaxGapMs = [int]$hugeProbe.HostSampleMaxGapMs
        $webViewResult = $hugeProbe.WebView
        $peakWebViewBytes = [long]$webViewResult.Bytes
        $peakWebViewCount = [int]$webViewResult.Count
        $peakTreeBytes = [long]$webViewResult.TreeBytes
        $treeApplicable = [bool]$webViewResult.TreeApplicable

        $hugeRawReady = Find-ReadyJson $hugeProbe.StdOut
        if ($null -ne $hugeRawReady) {
            $hugeCheck = Test-ReadyPayload -RawJson $hugeRawReady -ExpectedPath $hugeFilePath `
                -MaxElapsedMs $HugeElapsedLimitMs -MinTocCount $HugeTocMin
            $hugeElapsed = $hugeCheck.ElapsedMs
            $hugeToc = $hugeCheck.TocCount
            $hugeReasons = @()
            if ($hugeProbe.TimedOut) { $hugeReasons += "进程超时（> $HugeTimeoutSeconds s，尝试 $hugeAttempts 次）" }
            if ($hugeProbe.ExitCode -ne 0) { $hugeReasons += "exit $($hugeProbe.ExitCode)（期望 0）" }
            if (-not $hugeCheck.Ok) { $hugeReasons += $hugeCheck.Reason }
            $hugeReadyOk = ($hugeReasons.Count -eq 0)
            $hugeElapsedText = if ($null -eq $hugeElapsed) { '缺失' } else { [string]$hugeElapsed }
            $hugeTocText = if ($null -eq $hugeToc) { '缺失' } else { [string]$hugeToc }
            $hugeActual = "elapsedMs=$hugeElapsedText（≤ $HugeElapsedLimitMs）、tocCount=$hugeTocText（≥ $HugeTocMin）、exit $($hugeProbe.ExitCode)、ready=true、path 一致"
            if ($hugeAttempts -gt 1) {
                $hugeActual += "；尝试 $hugeAttempts 次（首次超时后重试）"
            }
            if (-not $hugeReadyOk) {
                $hugeActual += '；原因：' + ($hugeReasons -join '；') + "；READY 原始行：$hugeRawReady"
                if ($hugeDebugTail) { $hugeActual += "；debug.log：$hugeDebugTail" }
            }
        } else {
            $hugeActual = "未解析到 READY JSON；exit $($hugeProbe.ExitCode)；超时=$($hugeProbe.TimedOut)（尝试 $hugeAttempts 次）；" + `
                (Get-ShortText ($hugeProbe.StdOut + ' ' + $hugeProbe.StdErr) 300)
            if ($hugeDebugTail) { $hugeActual += "；debug.log：$hugeDebugTail" }
        }

        # I3/I7：采样最大间隔 > 250 ms 判 FAIL（防采样空洞假通过）；5 万行渲染未成功时内存项不适用/FAIL。
        $sampleGapOk = ($memorySamples -ge 2) -and ($hostSampleMaxGapMs -le $HostSampleMaxGapLimitMs)
        $limitText = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:0.0} MB', [double]$MemoryLimitMb)
        if (-not $hugeReadyOk) {
            $memoryActual = "不适用/FAIL（5 万行渲染未通过，内存判定不成立）；采样 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms"
            $memoryOk = $false
        } elseif ($memorySamples -eq 0) {
            $memoryActual = '未采集到宿主私有内存样本（进程退出过快或无法读取进程）'
            $webViewBaselineActual = '未采集到 WebView2 内存样本'
            $memoryOk = $false
        } elseif (-not $sampleGapOk) {
            $memoryActual = "峰值 $(Format-Mb $peakPrivateBytes)；采样 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms > $HostSampleMaxGapLimitMs ms（采样空洞，峰值不可信）"
            $memoryOk = $false
        } else {
            $memoryActual = "峰值 $(Format-Mb $peakPrivateBytes)（≤ $limitText；PrivateMemorySize64，宿主 $HostSampleIntervalMs ms 采样 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms）"
            $memoryOk = ($peakPrivateBytes -gt 0) -and ($peakPrivateBytes -le $MemoryLimitBytes)
            if (-not $memoryOk) {
                $memoryActual += '；超出上限'
            }
        }
        if ($memorySamples -gt 0) {
            $webViewBaselineActual = "峰值 $(Format-Mb $peakWebViewBytes)（$peakWebViewCount 个 msedgewebview2 进程；WebView2 $WebViewSampleIntervalMs ms 采样 $($webViewResult.Samples) 次）"
            if ($webViewResult.Error) {
                $webViewBaselineActual += '；采样器有错误，信息项可能偏低'
            }
        }
    }
    Add-Result -Name '5 万行首屏' -Expect "exit 0，READY 严格校验通过，elapsedMs ≤ $HugeElapsedLimitMs ms，tocCount ≥ $HugeTocMin，外层超时 $HugeTimeoutSeconds s" -Actual $hugeActual -Pass $hugeReadyOk
    Add-Result -Name "宿主私有内存峰值（≤$MemoryLimitMb MB）" -Expect "JingjingReader.exe PrivateMemorySize64 峰值 ≤ $MemoryLimitMb MB，采样最大间隔 ≤ $HostSampleMaxGapLimitMs ms" -Actual $memoryActual -Pass $memoryOk
    if (($memorySamples -gt 0) -or ($webViewResult.Samples -gt 0)) {
        Write-Host "[INFO] WebView2 基线（信息，进程组 WorkingSet64 之和）：$webViewBaselineActual（不参与 PASS/FAIL）" -ForegroundColor DarkGray
        $treeText = if ($treeApplicable) { (Format-Mb $peakTreeBytes) } else { '不适用（宿主已退出或 WorkingSet64 不可读）' }
        Write-Host "[INFO] 整树 WorkingSet（信息）：峰值 $treeText（宿主 WorkingSet64 + WebView2 进程组，同一采样时刻；仅参考）" -ForegroundColor DarkGray
    }
    if ($hugeHistory.Count -gt 0) {
        Write-Host "[INFO] 5 万行尝试历史：$($hugeHistory -join ' || ')" -ForegroundColor DarkGray
    }

    # ── ⑩ PDF 导出 ───────────────────────────────────────────────────────────
    Write-Host '[9/13] PDF 导出（--verify-pdf）…'
    $pdfHelloOk = $false
    $pdfHelloActual = ''
    $pdfHugeOk = $false
    $pdfHugeActual = ''
    $pdfHelloPath = Join-Path $TempRoot 'pdf/hello.pdf'
    $pdfHugePath = Join-Path $TempRoot 'pdf/huge.pdf'
    if (-not $canRunHost) {
        $pdfHelloActual = '跳过：运行副本缺失'
        $pdfHugeActual = '跳过：运行副本缺失'
    } else {
        $pdfHello = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 180000 `
            -Arguments @('--verify-pdf', (Join-Path $TempRoot 'hello.md'), $pdfHelloPath) -Environment $AppEnv
        $helloReady = Find-PdfReadyJson $pdfHello.StdOut
        $helloSize = [long]0
        if (Test-Path -LiteralPath $pdfHelloPath -PathType Leaf) {
            $helloSize = (Get-Item -LiteralPath $pdfHelloPath).Length
        }
        $pdfHelloOk = ($pdfHello.ExitCode -eq 0) -and ($helloSize -gt $PdfHelloLimitBytes) -and ($null -ne $helloReady)
        $pdfHelloActual = "exit $($pdfHello.ExitCode)；体积 $helloSize B（> 5120）"
        if ($null -ne $helloReady) {
            $pdfHelloActual += "；elapsedMs=$($helloReady.elapsedMs)"
        } else {
            $pdfHelloActual += '；' + (Get-ShortText ($pdfHello.StdOut + ' ' + $pdfHello.StdErr) 300)
        }

        $pdfHuge = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 300000 `
            -Arguments @('--verify-pdf', (Join-Path $TempRoot 'huge-50k-lines.md'), $pdfHugePath) -Environment $AppEnv
        $hugeReady = Find-PdfReadyJson $pdfHuge.StdOut
        $hugePdfSize = [long]0
        $pageCount = 0
        if (Test-Path -LiteralPath $pdfHugePath -PathType Leaf) {
            $hugePdfSize = (Get-Item -LiteralPath $pdfHugePath).Length
            try {
                $latin1 = [System.Text.Encoding]::GetEncoding(28591)
                $pdfText = [System.IO.File]::ReadAllText($pdfHugePath, $latin1)
                $pageCount = [regex]::Matches($pdfText, '/Type\s*/Page(?!s)').Count
            } catch {
                $pageCount = 0
            }
        }
        $pdfHugeOk = ($pdfHuge.ExitCode -eq 0) -and ($hugePdfSize -gt $PdfHugeLimitBytes) -and ($pageCount -gt 100) -and ($null -ne $hugeReady)
        $pdfHugeActual = "exit $($pdfHuge.ExitCode)；体积 $hugePdfSize B（> 1048576）；/Type /Page 页数 $pageCount（> 100）"
        if ($null -ne $hugeReady) {
            $pdfHugeActual += "；elapsedMs=$($hugeReady.elapsedMs)"
        } else {
            $pdfHugeActual += '；' + (Get-ShortText ($pdfHuge.StdOut + ' ' + $pdfHuge.StdErr) 300)
        }
    }
    Add-Result -Name 'PDF（hello.md）' -Expect 'exit 0，产物 > 5 KB' -Actual $pdfHelloActual -Pass $pdfHelloOk
    Add-Result -Name 'PDF（5 万行文档）' -Expect 'exit 0，产物 > 1 MB，页数 > 100' -Actual $pdfHugeActual -Pass $pdfHugeOk

    # ── ⑪ 双开单实例 ─────────────────────────────────────────────────────────
    Write-Host '[10/13] 双开单实例（两个宿主进程，校验第 2 个进程 ExitCode）…'
    $singleOk = $false
    $singleActual = ''
    if (-not $canRunHost) {
        $singleActual = '跳过：运行副本缺失'
    } else {
        $existing = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0) {
            $singleActual = "已有 $($existing.Count) 个 JingjingReader 进程在运行；无法验证双开（不杀用户进程）"
        } else {
            $first = $null
            $second = $null
            $firstFilePath = Join-Path $TempRoot 'hello.md'
            $secondFilePath = Join-Path $TempRoot 'full-syntax.md'
            # 调试日志在隔离数据目录（I2）：不再读用户 %APPDATA%，也不会污染它。
            $debugLogPath = Join-Path $JjDataDir 'debug.log'
            $logStartBytes = [long]0
            if (Test-Path -LiteralPath $debugLogPath -PathType Leaf) {
                try { $logStartBytes = (Get-Item -LiteralPath $debugLogPath).Length } catch { $logStartBytes = [long]0 }
            }
            try {
                # 用 .NET Process（不是 Start-Process）：需要拿到第 2 个进程的 ExitCode（I4），
                # 并显式传 JJ_DATA_DIR（I2）。PowerShell 5.1 的 Start-Process -PassThru + WaitForExit
                # 取 ExitCode 不可靠，这里统一走 ProcessStartInfo。
                $firstStartInfo = New-Object System.Diagnostics.ProcessStartInfo
                $firstStartInfo.FileName = $Exe
                $firstStartInfo.Arguments = Quote-Argument $firstFilePath
                $firstStartInfo.WorkingDirectory = $TempRoot
                $firstStartInfo.UseShellExecute = $false
                $firstStartInfo.EnvironmentVariables['JJ_DATA_DIR'] = $JjDataDir
                $first = New-Object System.Diagnostics.Process
                $first.StartInfo = $firstStartInfo
                $null = $first.Start()
                Register-TrackedProcess -Process $first -ExpectedPath $Exe

                # 先确认第 1 个窗口对应的进程已经出现（并留出初始化窗口），再启动第 2 个。
                $firstAppeared = $false
                for ($attempt = 0; $attempt -lt 50; $attempt++) {
                    if (Get-Process -Id $first.Id -ErrorAction SilentlyContinue) {
                        $firstAppeared = $true
                        break
                    }
                    Start-Sleep -Milliseconds 200
                }
                if (-not $firstAppeared) {
                    $singleActual = '第 1 个宿主进程未出现，无法验证双开'
                } else {
                    Start-Sleep -Milliseconds 500
                    $secondStartInfo = New-Object System.Diagnostics.ProcessStartInfo
                    $secondStartInfo.FileName = $Exe
                    $secondStartInfo.Arguments = Quote-Argument $secondFilePath
                    $secondStartInfo.WorkingDirectory = $TempRoot
                    $secondStartInfo.UseShellExecute = $false
                    $secondStartInfo.EnvironmentVariables['JJ_DATA_DIR'] = $JjDataDir
                    $second = New-Object System.Diagnostics.Process
                    $second.StartInfo = $secondStartInfo
                    $null = $second.Start()
                    Register-TrackedProcess -Process $second -ExpectedPath $Exe

                    # 第 2 个进程应把路径转交给第 1 个窗口后自行退出，且退出码必须为 0（I4）。
                    $secondExited = $false
                    $secondExitCode = $null
                    for ($attempt = 0; $attempt -lt 50; $attempt++) {
                        try {
                            if ($second.WaitForExit(200)) {
                                $secondExited = $true
                                $secondExitCode = [int]$second.ExitCode
                                break
                            }
                        } catch {
                            # 进程对象刚创建：下一轮再判断。
                        }
                    }
                    Start-Sleep -Seconds 3
                    $instances = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)
                    $singleOk = ($instances.Count -eq 1) -and $secondExited -and ($null -ne $secondExitCode) -and ($secondExitCode -eq 0)
                    $exitText = if ($null -eq $secondExitCode) { '未知' } else { [string]$secondExitCode }
                    $singleActual = "第 1 个进程已启动；第 2 个进程已退出=$secondExited（ExitCode=$exitText，期望 0）；3 s 后 JingjingReader 进程数=$($instances.Count)（期望 1）"

                    # debug.log 交叉校验保留为附加证据（不强制）：最后一条 load path 应等于第 2 个文件。
                    if (Test-Path -LiteralPath $debugLogPath -PathType Leaf) {
                        try {
                            $stream = [System.IO.File]::Open(
                                $debugLogPath,
                                [System.IO.FileMode]::Open,
                                [System.IO.FileAccess]::Read,
                                [System.IO.FileShare]::ReadWrite)
                            try {
                                if (($logStartBytes -gt 0) -and ($logStartBytes -le $stream.Length)) {
                                    $null = $stream.Seek($logStartBytes, [System.IO.SeekOrigin]::Begin)
                                }
                                $reader = New-Object System.IO.StreamReader -ArgumentList $stream, ([System.Text.UTF8Encoding]::new($false))
                                $logTail = $reader.ReadToEnd()
                                $reader.Dispose()
                            } finally {
                                $stream.Dispose()
                            }
                            $loadMatches = [regex]::Matches($logTail, '(?m)load path=(.+?) encoding=')
                            if ($loadMatches.Count -gt 0) {
                                $loggedPath = $loadMatches[$loadMatches.Count - 1].Groups[1].Value.Trim()
                                if (Test-PathEqualForVerify -Actual $loggedPath -Expected $secondFilePath) {
                                    $singleActual += '；附加证据 debug.log 最后一条 load path 与第 2 个文件一致'
                                } else {
                                    $singleActual += "；附加证据 debug.log 最后一条 load path 与第 2 个文件不一致（不影响判定）：$loggedPath"
                                }
                            } else {
                                $singleActual += '；debug.log 无新增 load 记录（附加证据缺失，不影响判定）'
                            }
                        } catch {
                            $singleActual += '；debug.log 读取失败（附加证据缺失，不影响判定）'
                        }
                    } else {
                        $singleActual += '；debug.log 不存在（附加证据缺失，不影响判定）'
                    }
                }
            } finally {
                # 清理也走快照校验（I8）：只停本次启动且身份匹配的进程。
                $rootIds = @()
                if ($first) { $rootIds += [int]$first.Id }
                if ($second) { $rootIds += [int]$second.Id }
                if ($rootIds.Count -gt 0) {
                    Stop-ProcessTree -RootIds $rootIds -WaitMs 3000
                }
                for ($attempt = 0; $attempt -lt 30; $attempt++) {
                    $remaining = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue | Where-Object {
                            try { $_.Path -eq $Exe } catch { $false }
                        })
                    if ($remaining.Count -eq 0) { break }
                    foreach ($process in $remaining) {
                        try {
                            Register-TrackedProcess -Process $process -ExpectedPath $Exe
                            $snapshot = $TrackedProcesses[[int]$process.Id]
                            if (Test-ProcessSnapshot $snapshot) {
                                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                            }
                        } catch { }
                    }
                    Start-Sleep -Milliseconds 100
                }
            }
        }
    }
    Add-Result -Name '双开单实例' -Expect '第 1 个窗口启动后，第 2 个进程转交并 ExitCode=0 退出，JingjingReader 进程数 = 1' -Actual $singleActual -Pass $singleOk

    # ── ⑫ 前端产物 ───────────────────────────────────────────────────────────
    Write-Host '[11/13] 前端产物体积与一致性…'
    $artifactOk = $false
    $artifactActual = ''
    $distArtifact = Join-Path $WebDir 'dist/md-engine.js'
    $resourceArtifact = Join-Path $Root 'src/Host/Resources/md-engine.js'
    if (-not (Test-Path -LiteralPath $distArtifact -PathType Leaf)) {
        $artifactActual = "缺少 $distArtifact（先运行 npm run build 或 scripts/build.ps1）"
    } elseif (-not (Test-Path -LiteralPath $resourceArtifact -PathType Leaf)) {
        $artifactActual = "缺少 $resourceArtifact"
    } else {
        $distSize = (Get-Item -LiteralPath $distArtifact).Length
        $resourceSize = (Get-Item -LiteralPath $resourceArtifact).Length
        $distHash = (Get-FileHash -LiteralPath $distArtifact -Algorithm SHA256).Hash
        $resourceHash = (Get-FileHash -LiteralPath $resourceArtifact -Algorithm SHA256).Hash
        $artifactOk = ($distSize -le $ArtifactLimitBytes) -and ($resourceSize -le $ArtifactLimitBytes) -and ($distHash -eq $resourceHash)
        $artifactActual = "dist=$distSize B，Resources=$resourceSize B（均 ≤ 512000）；SHA256 $(if ($distHash -eq $resourceHash) { '一致' } else { '不一致' })"
    }
    Add-Result -Name '前端产物体积' -Expect 'web/dist 与 src/Host/Resources 的 md-engine.js 均 ≤ 500 KB 且字节一致' -Actual $artifactActual -Pass $artifactOk

    # ── ⑬ 用户数据目录未被改写（I2 隔离的独立证据）────────────────────────────
    Write-Host '[12/13] 用户数据目录未被改写…'
    $appDataAfter = Get-FileState $AppDataRecentPath
    $appDataOk = ($AppDataRecentBefore.Exists -eq $appDataAfter.Exists) -and
        ($AppDataRecentBefore.Length -eq $appDataAfter.Length) -and
        ($AppDataRecentBefore.LastWriteUtc -eq $appDataAfter.LastWriteUtc) -and
        ($AppDataRecentBefore.Hash -eq $appDataAfter.Hash)
    $appDataActual = "验收前：$(Format-FileState $AppDataRecentBefore)；验收后：$(Format-FileState $appDataAfter)"
    if ($AppDataRecentBefore.Error -or $appDataAfter.Error) {
        $appDataOk = $false
        $appDataActual += "；读取错误：$($AppDataRecentBefore.Error) $($appDataAfter.Error)"
    }
    Add-Result -Name '用户数据目录未被改写' -Expect '验收前后 %APPDATA%\JingjingReader\recent.json 的 mtime/SHA256 完全一致（JJ_DATA_DIR 隔离生效）' `
        -Actual $appDataActual -Pass $appDataOk

    # 写报告前先做一次清理与残留检查：让报告里的「清理与残留检查」反映本次验收的真实结果
    # （finally 里还会再调一次 Stop-OurProcesses 兜底，那时报告已落盘）。
    Stop-OurProcesses

    # ── ⑭ 验收报告 ───────────────────────────────────────────────────────────
    $finishedAt = Get-Date
    $branch = ''
    $commit = ''
    $dirty = ''
    try {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if ($git) {
            $branch = (& $git.Source -C $Root rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
            $commit = (& $git.Source -C $Root rev-parse --short HEAD 2>$null | Select-Object -First 1)
            $dirty = (& $git.Source -C $Root status --porcelain 2>$null | Measure-Object).Count
        }
    } catch {
        $branch = ''
    }

    $dotnetVersion = Get-MatchValue $SelftestText '\.NET:\s*(.+)'
    $webView2Version = Get-MatchValue $SelftestText 'WebView2:\s*(.+)'
    $osVersion = Get-MatchValue $SelftestText 'OS:\s*(.+)'
    if (-not $dotnetVersion) { $dotnetVersion = '未知' }
    if (-not $webView2Version) { $webView2Version = '未知' }
    if (-not $osVersion) { $osVersion = [Environment]::OSVersion.VersionString }

    $reportLines = New-Object System.Collections.Generic.List[string]
    $reportLines.Add('# 鲸鲸阅读器验收报告')
    $reportLines.Add('')
    $reportLines.Add("- 生成时间：$($finishedAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))")
    $reportLines.Add("- 耗时：$([math]::Round(($finishedAt - $StartedAt).TotalSeconds, 1)) s")
    $reportLines.Add("- 仓库：$Root")
    if ($branch) {
        $worktreeState = if ($dirty -eq '0' -or $dirty -eq '') { '干净' } else { "有 $dirty 个未提交变更" }
        $reportLines.Add("- 分支：$branch @ $commit（工作树 $worktreeState）")
    }
    $reportLines.Add("- 操作系统：$osVersion")
    $reportLines.Add("- .NET：$dotnetVersion")
    $reportLines.Add("- WebView2 Runtime：$webView2Version")
    $reportLines.Add("- PowerShell：$($PSVersionTable.PSVersion)（$($PSVersionTable.PSEdition)）")
    $reportLines.Add("- 运行副本：$TempRoot（来源 $TempRootSource；$TempRootReason；ASCII 路径要求见说明；验收后清理）")
    $reportLines.Add("- 数据隔离：JJ_DATA_DIR=$JjDataDir（settings/recent/positions/debug.log 与 WebView2 profile 均在此；用户 %APPDATA%\JingjingReader 未被改写，见检查项）")
    $reportLines.Add("- 采样间隔：宿主 $HostSampleIntervalMs ms（本次 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms；上限 $HostSampleMaxGapLimitMs ms）/ WebView2 $WebViewSampleIntervalMs ms（本次 $($webViewResult.Samples) 次）")
    $reportLines.Add("- 5 万行尝试：$hugeAttempts 次；历史：$($hugeHistory -join ' || ')")
    $reportLines.Add("- 端到端首屏（Process.Start → READY）：$(if ($null -eq $fullFirstReadyMs) { '未采集' } else { ([math]::Round([double]$fullFirstReadyMs)).ToString() + ' ms' })；渲染器口径 elapsedMs=$fullElapsed ms（两者不同，见说明）")
    $e2eStatusText = ($Results | Where-Object { $_.Name -eq '端到端首屏（含 WebView2 初始化）' } | Select-Object -First 1).Status
    $reportLines.Add("- 端到端首屏判定：$e2eStatusText（< $E2ePassMs ms PASS；≤ $E2eWarnMs ms WARN；> $E2eWarnMs ms FAIL）")
    if ($CleanupNotes.Count -gt 0) {
        $reportLines.Add("- 清理与残留检查：$($CleanupNotes -join '；')")
    }
    $reportLines.Add('')
    $reportLines.Add('## 检查项')
    $reportLines.Add('')
    $reportLines.Add('| 检查项 | 期望 | 实测 | 结果 |')
    $reportLines.Add('| --- | --- | --- | --- |')
    foreach ($result in $Results) {
        $name = ([string]$result.Name) -replace '\|', '\|'
        $expect = ([string]$result.Expect) -replace '\|', '\|'
        $actual = ([string]$result.Actual) -replace '\|', '\|'
        $reportLines.Add("| $name | $expect | $actual | $($result.Status) |")
    }
    $reportLines.Add('')
    $reportLines.Add('## 说明')
    $reportLines.Add('')
    $reportLines.Add("- 内存判定口径（T17 裁定修正）：宿主进程 ``JingjingReader.exe`` 的 ``PrivateMemorySize64``（Private Bytes）峰值 ≤ $MemoryLimitMb MB；宿主每 $HostSampleIntervalMs ms 采样一次（采样循环内不做 CIM），本次 $memorySamples 个样本、最大间隔 $hostSampleMaxGapMs ms。最大间隔 > $HostSampleMaxGapLimitMs ms 判 FAIL（采样空洞可能漏掉峰值）；5 万行渲染未成功时该项记「不适用/FAIL」。上限按裁定 2（2026-10-18）由 150 MB 修正为 $MemoryLimitMb MB。")
    $reportLines.Add("- WebView2 基线（信息，独立 runspace 每 $WebViewSampleIntervalMs ms 采样）：" + $webViewBaselineActual + "；统计对象为直接子进程与全部后代的 ``msedgewebview2`` 进程组，取 ``WorkingSet64`` 之和；只记录，不参与 PASS/FAIL。")
    if (($memorySamples -gt 0) -or ($webViewResult.Samples -gt 0)) {
        $treeReport = if ($treeApplicable) { (Format-Mb $peakTreeBytes) } else { '不适用（宿主已退出或 WorkingSet64 不可读，不按 0 计）' }
        $reportLines.Add('- 整树 WorkingSet（信息）：峰值 ' + $treeReport + '（同一 WebView2 采样时刻的宿主 `WorkingSet64` + WebView2 进程组求和；仅参考）。')
    }
    $reportLines.Add('- 临时目录与隔离：优先 `%TEMP%`；若路径含非 ASCII 字符，依次回退 `%LOCALAPPDATA%\Temp`、脚本所在盘根目录下的 `jj-verify-<guid>`。要求纯 ASCII 的原因是「隔离 + 路径含中文时的兼容」：WebView2 子进程在该目录创建用户数据目录，且 `--verify-*` 的命令行/环境变量在非 ASCII 路径上受系统代码页影响。所有 exe 调用都显式传 `JJ_DATA_DIR=<临时目录>\appdata`（数据目录 + WebView2 profile），并校验用户 `%APPDATA%\JingjingReader\recent.json` 的 mtime/SHA256 前后一致。`JJ_DATA_DIR` 仅用于测试隔离（finally 恢复调用方原值）；产品默认 WebView2 UDF 仍是本地 `%LOCALAPPDATA%\JingjingReader\WebView2`，不进入漫游 `%APPDATA%`。')
    $reportLines.Add('- 首屏耗时有两套口径：`elapsedMs` 来自前端 `renderDone.elapsedMs`（渲染器耗时，`--verify-render` 的 READY JSON，≤ 1000/1500 ms 判定）；「端到端首屏」是 `Process.Start → stdout READY` 的墙钟耗时（含进程启动、WebView2 初始化、文件读取），< 1000 ms PASS、≤ 2500 ms WARN、> 2500 ms FAIL。spec 的 1.0 s 是设计目标，当前 CLI 冷启动含 WebView2 初始化，故 1.0–2.5 s 记 WARN 不判 FAIL。')
    $reportLines.Add('- READY 必须满足 `ready`=true、`elapsedMs` 为区间内 Number、`path` 与传入文件一致、`tocCount` 为 [下限, 上限] 内整数（full-syntax 36–40、5 万行 ≥ 480），否则该项 FAIL 并打印原始 READY 行。')
    $reportLines.Add('- 双开单实例：先等第 1 个宿主出现，再启动第 2 个；断言第 2 个进程退出且 ExitCode=0、3 s 后 JingjingReader 进程数=1；隔离数据目录 `debug.log` 的 `load path=` 交叉校验只作附加证据，不影响判定。若验收前已有用户实例在运行，该项明确失败而不是误杀用户进程。')
    $reportLines.Add('- 跳过测试：宿主 TRX 的 `notExecuted` 与 vitest 的 `skipped` 均按 FAIL 口径（skipped > 0 会在实测列列出跳过项；确需环境性跳过时应改为显式白名单并写明，默认仍是 FAIL）。')
    $reportLines.Add('- 宿主单测要求总计 > 0、失败 0、跳过 0；前端单测要求 `Test Files` 与 `Tests` 的 passed 数均 > 0 且 skipped = 0（零测试/跳过都不能通过）。')
    $reportLines.Add('- 分发包：`out\`（或 `out-selfcontained\`）内含 `JingjingReader.exe`、`install.ps1`、`uninstall.ps1`、`README.md`，整个目录可直接分发。')
    $reportLines.Add('- 本脚本不安装/卸载 .md 关联、不写注册表；默认应用、拖放、主题等交互项见 docs/verify-checklist.md。')
    $reportLines.Add('')
    if ($Failures -gt 0) {
        $reportLines.Add("## 结论")
        $reportLines.Add('')
        $reportLines.Add("**VERIFY FAILED**：$Failures 项未通过（见上表 FAIL 行）。")
    } else {
        $reportLines.Add('## 结论')
        $reportLines.Add('')
        $reportLines.Add('**VERIFY OK**：全部检查通过。')
    }

    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $reportText = ($reportLines -join [Environment]::NewLine) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($ReportPath, $reportText, [System.Text.UTF8Encoding]::new($false))
    Write-Host ''
    Write-Host "验收报告：$ReportPath"

    if ($Failures -gt 0) {
        Write-Host "VERIFY FAILED（$Failures 项失败）" -ForegroundColor Red
        exit 1
    }
    Write-Host 'VERIFY OK' -ForegroundColor Green
    exit 0
} catch {
    # 脚本自身异常：打印上下文并尽力留下失败报告/退出码 1。
    Write-Host ''
    Write-Host ('VERIFY FAILED（脚本异常）：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
    try {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        $exceptionLines = @(
            '# 鲸鲸阅读器验收报告',
            '',
            "- 生成时间：$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))",
            '',
            '脚本执行异常，验收未完成：',
            '',
            '```',
            [string]$_.Exception,
            [string]$_.ScriptStackTrace,
            '```'
        )
        [System.IO.File]::WriteAllText($ReportPath, (($exceptionLines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    } catch {
        Write-Host '无法写入验收报告。'
    }
    exit 1
} finally {
    Stop-OurProcesses
    Start-Sleep -Milliseconds 300
    try { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    # 修复波 D：恢复调用方原有的 JJ_DATA_DIR（存在则还原值，不存在则删除），不把隔离变量泄漏给后续命令。
    try {
        if ($PreviousJjDataDirExists) {
            $env:JJ_DATA_DIR = $PreviousJjDataDir
        } else {
            Remove-Item Env:JJ_DATA_DIR -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Host '无法恢复调用方原有的 JJ_DATA_DIR 环境变量。'
    }
}
