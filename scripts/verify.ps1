#Requires -Version 5.1
<#
鲸鲸阅读器验收脚本（Task 17，spec §9.3）。

做什么：
  1. 构建（scripts/build.ps1）
  2. 宿主单测（dotnet test）
  3. 前端单测（web/ 下 npm test）
  4. 把 out\ 复制到 ASCII 临时目录，后续启动实测都用这份副本
  5. --selftest：产品名 / .NET / WebView2 / OS
  6. --verify-render samples/full-syntax.md：首屏 ≤ 1000 ms、tocCount ≥ 30
  7. --verify-render samples/huge-50k-lines.md：exit 0、READY 严格校验、首屏 ≤ 1500 ms、tocCount ≥ 400 + 宿主私有内存峰值 ≤ 200 MB
  8. --verify-pdf：hello > 5 KB；5 万行文档 > 1 MB 且页数 > 100
  9. 双开单实例：两个宿主进程同时打开不同文档，JingjingReader 进程数必须为 1
 10. 前端产物 ≤ 500 KB，且 web/dist 与 src/Host/Resources 两份字节一致
 11. 写 out/verify-report.md，终端打印 VERIFY OK / VERIFY FAILED

约定：
  - 每步输出 [PASS]/[FAIL] 名称 详情；失败不中断，继续跑完并汇总，最终 exit 1。
  - 不在本脚本里安装/卸载 .md 关联（不写注册表）：那属于 install.ps1/uninstall.ps1 与手测清单。
  - 内存判定口径（Controller 裁定，T17 修正）：宿主进程（JingjingReader.exe）的 PrivateMemorySize64
    （Private Bytes）峰值 ≤ 200 MB，50 ms 采样取峰值。WebView2 进程组（直接子进程与全部后代）
    的 WorkingSet64 之和只作为信息项记录，不参与 PASS/FAIL；对应 spec §2.3 第 2 条。
  - 裁定 2（2026-10-18）：上限由 150 MB 修正为 200 MB（WebView2 155 下宿主实测基线
    160.6–171.9 MB，原 150 MB 为设计阶段未实测预算）；150 MB 保留为后续优化目标。
  - READY 严格校验：`ready` 必须是 JSON boolean true、`elapsedMs` 必须是 [0, 上限] 内的 Number、
    `path` 必须非空且与传入文件一致（归一化后比较）、`tocCount` 必须为 ≥ 下限的整数；任何一项不满足
    都判 FAIL 并打印原始 READY 行。
  - 临时目录：优先 %TEMP%\jj-verify-<guid>；若路径含非 ASCII 字符，依次回退
    %LOCALAPPDATA%\Temp、脚本所在盘根目录下的 jj-verify-<guid>（WebView2 用户数据目录要求纯 ASCII
    路径，避免系统代码页/命令行编码差异）。结束后清理；只停止本脚本启动的宿主进程及其后代。

用法：
  pwsh -NoProfile -File scripts/verify.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
#>
[CmdletBinding()]
param()

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
# 判定上限统一从这里引用：内存上限（MB）同时用于判定与文案，避免两处数字漂移。
$MemoryLimitMb = 200
$MemoryLimitBytes = $MemoryLimitMb * $MB
$FullElapsedLimitMs = 1000
$HugeElapsedLimitMs = 1500
$FullTocMin = 30
$HugeTocMin = 400
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
$Exe = $null
$SelftestText = ''
$OurAppPids = New-Object 'System.Collections.Generic.HashSet[int]'
$StartedAt = Get-Date

# ── 通用小工具 ────────────────────────────────────────────────────────────────

function Add-Result {
    param(
        [string]$Name,
        [string]$Expect,
        [string]$Actual,
        [bool]$Pass,
        [string]$Detail = ''
    )
    $status = if ($Pass) { 'PASS' } else { 'FAIL' }
    $null = $Results.Add([pscustomobject]@{
            Name   = $Name
            Expect = $Expect
            Actual = $Actual
            Status = $status
            Detail = $Detail
        })
    $color = if ($Pass) { 'Green' } else { 'Red' }
    Write-Host "[$status] $Name：$Actual" -ForegroundColor $color
    if (-not $Pass) {
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
        [int]$TimeoutMs = 600000
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
        $null = $OurAppPids.Add([int]$process.Id)
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
    try { $stdout = [string]$stdoutTask.Result } catch { $stdout = '' }
    try { $stderr = [string]$stderrTask.Result } catch { $stderr = '' }

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
        [int]$MinTocCount = 0
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

    # tocCount：>= MinTocCount 的整数。
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
      宿主单测判定：exit 0、总计 > 0、失败 = 0、通过 > 0。
      TRX Counters 优先；没有 TRX 时从控制台输出解析「失败/通过/总计」或「Failed/Passed/Total」。
      关键修复：total=0（零测试）必须 FAIL，不能因为「失败 0」就放行。
    #>
    param(
        [int]$ExitCode,
        [string]$Text,
        $Failed = $null,
        $Passed = $null,
        $Total = $null
    )
    $result = [pscustomobject]@{
        Ok = $false; Reason = ''; Failed = $Failed; Passed = $Passed; Total = $Total; Source = ''
    }
    if ($ExitCode -ne 0) {
        $result.Reason = "dotnet test exit $ExitCode"
        return $result
    }
    if ($null -eq $Total) {
        $failedMatch = [regex]::Match($Text, '(?:失败|Failed):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $passedMatch = [regex]::Match($Text, '(?:通过|Passed):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $totalMatch = [regex]::Match($Text, '(?:总计|Total):\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $totalMatch.Success) {
            $result.Reason = '无法从 dotnet test 输出解析总计（total）'
            return $result
        }
        $result.Total = [int]$totalMatch.Groups[1].Value
        if ($failedMatch.Success) { $result.Failed = [int]$failedMatch.Groups[1].Value }
        if ($passedMatch.Success) { $result.Passed = [int]$passedMatch.Groups[1].Value }
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
if ($RootProcessId -gt 0) {
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $root = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if (-not $root) { break }
        try {
            $group = Get-WebViewGroupWorkingSet -RootProcessId $RootProcessId
            if ($group.Error) { $errors += 1 }
            if (($group.Bytes -gt 0) -or ($group.Count -gt 0)) {
                $samples += 1
                if ($group.Bytes -gt $peakBytes) {
                    $peakBytes = [long]$group.Bytes
                    $peakCount = [int]$group.Count
                }
                $hostWs = [long]0
                try { $hostWs = [long]$root.WorkingSet64 } catch { $hostWs = [long]0 }
                $treeBytes = $hostWs + [long]$group.Bytes
                if ($treeBytes -gt $peakTreeBytes) { $peakTreeBytes = $treeBytes }
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
        Bytes = [long]0; Count = 0; TreeBytes = [long]0; Samples = 0; Error = $true
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

function Stop-ProcessTree {
    # 从给定根 PID 出发 BFS 收集全部后代（含 WebView2 各层），按深度从深到浅停止。
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
    foreach ($processId in $ordered) {
        try { Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue } catch { }
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

function Stop-OurProcesses {
    <#
      只清理本次启动的宿主及其后代：根 PID 来自 $OurAppPids，另加「可执行文件路径等于本次副本 exe」
      的兜底（绝不碰用户其它实例）。BFS 覆盖 WebView2 全部后代，最后确认无残留。
    #>
    $roots = New-Object System.Collections.Generic.List[int]
    foreach ($processId in $OurAppPids) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            $roots.Add([int]$processId)
        }
    }
    if ($Exe) {
        foreach ($process in @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)) {
            try {
                if ($process.Path -and ($process.Path -eq $Exe)) {
                    $roots.Add([int]$process.Id)
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
            Write-Host "[WARN] 验收后仍有 $($leftover.Count) 个副本进程残留（PID：$leftoverIds）" -ForegroundColor Yellow
        }
    }
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
if ($tempRootInfo.Attempts) {
    Write-Host "临时目录回退记录：$($tempRootInfo.Attempts)"
}
Write-Host ''

try {
    # ── ① 构建 ───────────────────────────────────────────────────────────────
    Write-Host '[1/10] 构建（scripts/build.ps1）…'
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
    Write-Host '[2/10] 宿主单测（dotnet test）…'
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
        if (Test-Path -LiteralPath $trxPath -PathType Leaf) {
            try {
                [xml]$trx = Get-Content -LiteralPath $trxPath -Raw -Encoding UTF8
                $counters = @($trx.GetElementsByTagName('Counters') | Select-Object -First 1)
                if ($counters.Count -gt 0) {
                    $failedCount = [int]$counters[0].GetAttribute('failed')
                    $passedCount = [int]$counters[0].GetAttribute('passed')
                    $totalCount = [int]$counters[0].GetAttribute('total')
                }
            } catch {
                $failedCount = $null
            }
        }
        $hostCheck = Test-HostTestSummary -ExitCode $dotnetTest.ExitCode -Text $hostText `
            -Failed $failedCount -Passed $passedCount -Total $totalCount
        $hostTestOk = $hostCheck.Ok
        if ($null -ne $totalCount) {
            $hostTestActual = "失败 $failedCount / 通过 $passedCount / 总计 $totalCount（$($hostCheck.Source)）"
        } else {
            $hostTestActual = "exit $($dotnetTest.ExitCode)；" + (Get-ShortText (($hostText -split "`r?`n" | Where-Object { $_ -match '通过|Passed|失败|Failed|总计|Total' } | Select-Object -Last 3) -join ' | ') 300)
        }
        if (-not $hostTestOk) {
            $hostTestActual += "；原因：$($hostCheck.Reason)"
        }
        if (-not $hostTestOk -and $dotnetTest.TimedOut) {
            $hostTestActual = '测试超时（> 15 分钟）'
        }
    }
    Add-Result -Name '宿主单测' -Expect 'dotnet test 全绿（总计 > 0 且失败 0）' -Actual $hostTestActual -Pass $hostTestOk

    # ── ③ 前端单测 ───────────────────────────────────────────────────────────
    Write-Host '[3/10] 前端单测（cd web; npm test）…'
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
        $testFilesValue = 0
        $testCountValue = 0
        $parsedFiles = [int]::TryParse($testFilesText, [ref]$testFilesValue)
        $parsedTests = [int]::TryParse($testCountText, [ref]$testCountValue)
        $hasFailedSummary = ($webText -match 'Tests\s+\d+\s+failed')
        # 零测试不能算通过：Test Files 与 Tests 都必须 > 0。
        $webTestOk = ($webTest.ExitCode -eq 0) -and $parsedFiles -and $parsedTests -and
            ($testFilesValue -gt 0) -and ($testCountValue -gt 0) -and (-not $hasFailedSummary)
        $webTestActual = "exit $($webTest.ExitCode)；Test Files $testFilesValue passed / Tests $testCountValue passed"
        if (-not $webTestOk) {
            $failReason = if (-not $parsedFiles -or -not $parsedTests) {
                '无法解析 Test Files/Tests 通过数'
            } elseif ($testFilesValue -le 0 -or $testCountValue -le 0) {
                'Test Files 或 Tests 为 0（零测试不能通过）'
            } elseif ($hasFailedSummary) {
                '存在 failed 用例'
            } else {
                "exit $($webTest.ExitCode)"
            }
            $webTestActual += "；原因：$failReason；" + (Get-ShortText (($webText -split "`r?`n" | Where-Object { $_ -match 'FAIL|failed|Error' } | Select-Object -Last 3) -join ' | ') 300)
        }
    }
    Add-Result -Name '前端单测' -Expect 'web/npm test 全绿（Test Files > 0 且 Tests > 0）' -Actual $webTestActual -Pass $webTestOk

    # ── ④ 复制 out 到 ASCII 临时目录 ─────────────────────────────────────────
    Write-Host '[4/10] 复制 out\ 到 ASCII 临时目录…'
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
            $copyActual = "副本 $Exe（$(Format-Mb (Get-Item -LiteralPath $Exe).Length)）"
        }
    } catch {
        $copyActual = '复制失败：' + $_.Exception.Message
    }
    Add-Result -Name 'ASCII 运行副本' -Expect 'out\ 完整复制到纯 ASCII 临时目录（%TEMP% 或回退目录）' -Actual $copyActual -Pass $copyOk

    # 后续启动实测都依赖副本 exe；缺失时明确跳过并给 FAIL 行，不让脚本抛异常中断。
    $canRunHost = $copyOk

    # ── ⑤ 环境自检 ───────────────────────────────────────────────────────────
    Write-Host '[5/10] 环境自检（--selftest）…'
    $selftestOk = $false
    $selftestActual = ''
    if (-not $canRunHost) {
        $selftestActual = '跳过：运行副本缺失'
    } else {
        $selftest = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 60000 -Arguments @('--selftest')
        $SelftestText = $selftest.StdOut
        $productLine = Get-MatchValue $SelftestText '产品名:\s*(.+)'
        $selftestOk = ($selftest.ExitCode -eq 0) -and ($SelftestText -match '产品名:\s*鲸鲸阅读器')
        $selftestActual = "exit $($selftest.ExitCode)；产品名=$productLine"
        if (-not $selftestOk) {
            $selftestActual += '；' + (Get-ShortText ($selftest.StdOut + ' ' + $selftest.StdErr) 300)
        }
    }
    Add-Result -Name '环境自检' -Expect 'exit 0 且 stdout 含「产品名: 鲸鲸阅读器」' -Actual $selftestActual -Pass $selftestOk

    # ── ⑥ full-syntax 首屏 ───────────────────────────────────────────────────
    Write-Host '[6/10] full-syntax 首屏（--verify-render）…'
    $fullOk = $false
    $fullActual = ''
    $fullElapsed = $null
    if (-not $canRunHost) {
        $fullActual = '跳过：运行副本缺失'
    } else {
        $fullFilePath = Join-Path $TempRoot 'full-syntax.md'
        $renderFull = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 60000 `
            -Arguments @('--verify-render', $fullFilePath)
        $fullRawReady = Find-ReadyJson $renderFull.StdOut
        if ($null -ne $fullRawReady) {
            $fullCheck = Test-ReadyPayload -RawJson $fullRawReady -ExpectedPath $fullFilePath `
                -MaxElapsedMs $FullElapsedLimitMs -MinTocCount $FullTocMin
            $fullElapsed = $fullCheck.ElapsedMs
            $tocCount = $fullCheck.TocCount
            $fullOk = ($renderFull.ExitCode -eq 0) -and $fullCheck.Ok
            $fullActual = "elapsedMs=$fullElapsed（≤ $FullElapsedLimitMs）、tocCount=$tocCount（≥ $FullTocMin）、exit $($renderFull.ExitCode)、ready=true、path 一致"
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
    Add-Result -Name 'full-syntax 首屏' -Expect 'elapsedMs ≤ 1000 ms，tocCount ≥ 30，exit 0 且 READY 字段合法' -Actual $fullActual -Pass $fullOk

    # ── ⑦ 5 万行首屏 + 宿主私有内存峰值（WebView2 进程组仅作信息项）──────────
    Write-Host '[7/10] 5 万行首屏与内存峰值（--verify-render + 宿主 50 ms 采样）…'
    $hugeElapsed = $null
    $hugeToc = $null
    $hugeReadyOk = $false
    $hugeActual = ''
    $peakPrivateBytes = [long]0
    $peakWebViewBytes = [long]0
    $peakWebViewCount = 0
    $peakTreeBytes = [long]0
    $memorySamples = 0
    $hostSampleMaxGapMs = 0
    $memoryOk = $false
    $memoryActual = ''
    $webViewBaselineActual = '未采集'
    $webViewResult = [pscustomobject]@{
        Bytes = [long]0; Count = 0; TreeBytes = [long]0; Samples = 0; Error = $true
    }
    if (-not $canRunHost) {
        $hugeActual = '跳过：运行副本缺失'
        $memoryActual = '跳过：运行副本缺失'
    } else {
        $hugeFilePath = Join-Path $TempRoot 'huge-50k-lines.md'
        $hugeProcess = $null
        $hugeStdOut = ''
        $hugeStdErr = ''
        $hugeExitCode = -1
        $timedOut = $false
        $launched = $false
        $webViewSampler = $null
        $webViewStartFile = Join-Path $TempRoot 'webview-sampler.start'
        $webViewStopFile = Join-Path $TempRoot 'webview-sampler.stop'
        $webViewResultFile = Join-Path $TempRoot 'webview-sampler.json'
        $webViewReadyFile = Join-Path $TempRoot 'webview-sampler.ready'
        try {
            # 用 .NET Process（不是 Start-Process -PassThru）：Windows PowerShell 5.1 下
            # Start-Process + WaitForExit(ms) 取不到 ExitCode，会让「READY 但非零退出」蒙混过关。
            $hugeStartInfo = New-Object System.Diagnostics.ProcessStartInfo
            $hugeStartInfo.FileName = $Exe
            $hugeStartInfo.Arguments = '--verify-render ' + (Quote-Argument $hugeFilePath)
            $hugeStartInfo.WorkingDirectory = $TempRoot
            $hugeStartInfo.UseShellExecute = $false
            $hugeStartInfo.CreateNoWindow = $true
            $hugeStartInfo.RedirectStandardOutput = $true
            $hugeStartInfo.RedirectStandardError = $true
            $hugeStartInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
            $hugeStartInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)

            foreach ($samplerFile in @($webViewStartFile, $webViewStopFile, $webViewResultFile, $webViewReadyFile)) {
                if (Test-Path -LiteralPath $samplerFile) {
                    Remove-Item -LiteralPath $samplerFile -Force -ErrorAction SilentlyContinue
                }
            }
            # 先在后台 runspace 预热 CIM，再等主脚本写入宿主 PID；这样 500 ms 采样能覆盖
            # 短命的 --verify-render 进程（160 ms 首屏 + WebView2 关闭约 1 s）。
            $webViewSampler = Start-WebViewSampler -StartFile $webViewStartFile `
                -StopFile $webViewStopFile -ResultFile $webViewResultFile -ReadyFile $webViewReadyFile `
                -IntervalMs $WebViewSampleIntervalMs
            # 等采样器完成预热再启动宿主，保证第一个 500 ms 采样点落在 WebView2 存活窗口内。
            $readyDeadline = (Get-Date).AddSeconds(5)
            while ((-not (Test-Path -LiteralPath $webViewReadyFile)) -and ((Get-Date) -lt $readyDeadline)) {
                Start-Sleep -Milliseconds 20
            }

            $hugeProcess = New-Object System.Diagnostics.Process
            $hugeProcess.StartInfo = $hugeStartInfo
            $null = $hugeProcess.Start()
            $launched = $true
            $null = $OurAppPids.Add([int]$hugeProcess.Id)
            [System.IO.File]::WriteAllText($webViewStartFile, [string]$hugeProcess.Id, [System.Text.UTF8Encoding]::new($false))
            $hugeStdoutTask = $hugeProcess.StandardOutput.ReadToEndAsync()
            $hugeStderrTask = $hugeProcess.StandardError.ReadToEndAsync()

            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            $nextHostSampleMs = 0
            $lastHostSampleMs = $null
            try {
                while (-not $hugeProcess.HasExited) {
                    $nowMs = $stopwatch.Elapsed.TotalMilliseconds
                    if ($nowMs -ge $nextHostSampleMs) {
                        $samplePrivate = [long]0
                        try {
                            $hugeProcess.Refresh()
                            $samplePrivate = [long]$hugeProcess.PrivateMemorySize64
                        } catch {
                            $samplePrivate = [long]0
                        }
                        if ($samplePrivate -gt 0) {
                            $memorySamples += 1
                            if ($samplePrivate -gt $peakPrivateBytes) { $peakPrivateBytes = $samplePrivate }
                            if ($null -ne $lastHostSampleMs) {
                                $gapMs = [int][math]::Round($nowMs - $lastHostSampleMs)
                                if ($gapMs -gt $hostSampleMaxGapMs) { $hostSampleMaxGapMs = $gapMs }
                            }
                            $lastHostSampleMs = $nowMs
                        }
                        $nextHostSampleMs = $nowMs + $HostSampleIntervalMs
                    }
                    if ($stopwatch.Elapsed.TotalSeconds -gt 180) {
                        $timedOut = $true
                        try { $hugeProcess.Kill() } catch { }
                        break
                    }
                    Start-Sleep -Milliseconds 10
                }
            } finally {
                try { $null = $hugeProcess.WaitForExit(10000) } catch { }
                # 通知 WebView2 采样器退出；宿主已退出时它也会自行结束。
                New-Item -ItemType File -Path $webViewStopFile -Force -ErrorAction SilentlyContinue | Out-Null
            }

            $webViewResult = Receive-WebViewSampler -Sampler $webViewSampler -TimeoutMs 20000
            $webViewSampler = $null
            try { $hugeStdOut = [string]$hugeStdoutTask.Result } catch { $hugeStdOut = '' }
            try { $hugeStdErr = [string]$hugeStderrTask.Result } catch { $hugeStdErr = '' }
            try {
                if ($hugeProcess.HasExited) { $hugeExitCode = [int]$hugeProcess.ExitCode }
            } catch {
                $hugeExitCode = -1
            }
            $hugeProcess.Dispose()
        } catch {
            $hugeActual = '启动/采样异常：' + $_.Exception.Message
            $memoryActual = '启动/采样异常：' + $_.Exception.Message
            if ($webViewSampler) {
                New-Item -ItemType File -Path $webViewStopFile -Force -ErrorAction SilentlyContinue | Out-Null
                try { $null = Receive-WebViewSampler -Sampler $webViewSampler -TimeoutMs 5000 } catch { }
                $webViewSampler = $null
            }
            try { if ($hugeProcess) { $hugeProcess.Dispose() } } catch { }
        }

        if ($launched) {
            $peakWebViewBytes = [long]$webViewResult.Bytes
            $peakWebViewCount = [int]$webViewResult.Count
            $peakTreeBytes = [long]$webViewResult.TreeBytes

            $hugeRawReady = Find-ReadyJson $hugeStdOut
            if ($null -ne $hugeRawReady) {
                $hugeCheck = Test-ReadyPayload -RawJson $hugeRawReady -ExpectedPath $hugeFilePath `
                    -MaxElapsedMs $HugeElapsedLimitMs -MinTocCount $HugeTocMin
                $hugeElapsed = $hugeCheck.ElapsedMs
                $hugeToc = $hugeCheck.TocCount
                $hugeReasons = @()
                if ($timedOut) { $hugeReasons += '进程超时（> 180 s）' }
                if ($hugeExitCode -ne 0) { $hugeReasons += "exit $hugeExitCode（期望 0）" }
                if (-not $hugeCheck.Ok) { $hugeReasons += $hugeCheck.Reason }
                $hugeReadyOk = ($hugeReasons.Count -eq 0)
                $hugeElapsedText = if ($null -eq $hugeElapsed) { '缺失' } else { [string]$hugeElapsed }
                $hugeTocText = if ($null -eq $hugeToc) { '缺失' } else { [string]$hugeToc }
                $hugeActual = "elapsedMs=$hugeElapsedText（≤ $HugeElapsedLimitMs）、tocCount=$hugeTocText（≥ $HugeTocMin）、exit $hugeExitCode、ready=true、path 一致"
                if (-not $hugeReadyOk) {
                    $hugeActual += '；原因：' + ($hugeReasons -join '；') + "；READY 原始行：$hugeRawReady"
                }
            } else {
                $hugeActual = "未解析到 READY JSON；exit $hugeExitCode；超时=$timedOut；" + `
                    (Get-ShortText ($hugeStdOut + ' ' + $hugeStdErr) 300)
            }

            $memoryOk = (-not $timedOut) -and ($peakPrivateBytes -gt 0) -and ($peakPrivateBytes -le $MemoryLimitBytes)
            if ($memorySamples -eq 0) {
                $memoryActual = '未采集到宿主私有内存样本（进程退出过快或无法读取进程）'
                $webViewBaselineActual = '未采集到 WebView2 内存样本'
            } else {
                $limitText = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:0.0} MB', [double]$MemoryLimitMb)
                $memoryActual = "峰值 $(Format-Mb $peakPrivateBytes)（≤ $limitText；PrivateMemorySize64，宿主 $HostSampleIntervalMs ms 采样 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms）"
                $webViewBaselineActual = "峰值 $(Format-Mb $peakWebViewBytes)（$peakWebViewCount 个 msedgewebview2 进程；WebView2 $WebViewSampleIntervalMs ms 采样 $($webViewResult.Samples) 次）"
                if ($webViewResult.Error) {
                    $webViewBaselineActual += '；采样器有错误，信息项可能偏低'
                }
            }
        } elseif (-not $memoryActual) {
            $memoryActual = '未启动，无内存样本'
        }
    }
    Add-Result -Name '5 万行首屏' -Expect "exit 0，READY 严格校验通过，elapsedMs ≤ $HugeElapsedLimitMs ms，tocCount ≥ $HugeTocMin" -Actual $hugeActual -Pass $hugeReadyOk
    Add-Result -Name "宿主私有内存峰值（≤$MemoryLimitMb MB）" -Expect "JingjingReader.exe PrivateMemorySize64 峰值 ≤ $MemoryLimitMb MB" -Actual $memoryActual -Pass $memoryOk
    if (($memorySamples -gt 0) -or ($webViewResult.Samples -gt 0)) {
        Write-Host "[INFO] WebView2 基线（信息，进程组 WorkingSet64 之和）：$webViewBaselineActual（不参与 PASS/FAIL）" -ForegroundColor DarkGray
        Write-Host "[INFO] 整树 WorkingSet（信息）：峰值 $(Format-Mb $peakTreeBytes)（宿主 WorkingSet64 + WebView2 进程组，同一采样时刻；仅参考）" -ForegroundColor DarkGray
    }

    # ── ⑧ PDF 导出 ───────────────────────────────────────────────────────────
    Write-Host '[8/10] PDF 导出（--verify-pdf）…'
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
            -Arguments @('--verify-pdf', (Join-Path $TempRoot 'hello.md'), $pdfHelloPath)
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
            -Arguments @('--verify-pdf', (Join-Path $TempRoot 'huge-50k-lines.md'), $pdfHugePath)
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

    # ── ⑨ 双开单实例 ─────────────────────────────────────────────────────────
    Write-Host '[9/10] 双开单实例（两个宿主进程）…'
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
            $debugLogPath = Join-Path $env:APPDATA 'JingjingReader/debug.log'
            $logStartBytes = [long]0
            if (Test-Path -LiteralPath $debugLogPath -PathType Leaf) {
                try { $logStartBytes = (Get-Item -LiteralPath $debugLogPath).Length } catch { $logStartBytes = [long]0 }
            }
            try {
                $firstParams = @{
                    FilePath         = $Exe
                    WorkingDirectory = $TempRoot
                    PassThru         = $true
                    ArgumentList     = @((Quote-Argument $firstFilePath))
                }
                $first = Start-Process @firstParams
                $null = $OurAppPids.Add([int]$first.Id)

                # 先确认第 1 个窗口对应的进程已经出现，再启动第 2 个。
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
                    $secondParams = @{
                        FilePath         = $Exe
                        WorkingDirectory = $TempRoot
                        PassThru         = $true
                        ArgumentList     = @((Quote-Argument $secondFilePath))
                    }
                    $second = Start-Process @secondParams
                    $null = $OurAppPids.Add([int]$second.Id)

                    # 第 2 个进程应把路径转交给第 1 个窗口后自行退出。
                    $secondExited = $false
                    for ($attempt = 0; $attempt -lt 50; $attempt++) {
                        try {
                            if ($second.HasExited) {
                                $secondExited = $true
                                break
                            }
                        } catch {
                            # 进程对象刚创建/退出：下一轮再判断。
                        }
                        Start-Sleep -Milliseconds 200
                    }
                    Start-Sleep -Seconds 3
                    $instances = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)
                    $singleOk = ($instances.Count -eq 1) -and $secondExited
                    $singleActual = "第 1 个进程已启动；第 2 个进程已退出=$secondExited；3 s 后 JingjingReader 进程数=$($instances.Count)（期望 1）"

                    # 可选：debug.log 里最后一条 load path= 应等于第 2 个文件。
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
                                    $singleActual += '；debug.log 最后一条 load path 与第 2 个文件一致'
                                } else {
                                    $singleOk = $false
                                    $singleActual += "；debug.log 最后一条 load path 与第 2 个文件不一致：$loggedPath"
                                }
                            } else {
                                $singleActual += '；debug.log 无新增 load 记录（可选检查跳过）'
                            }
                        } catch {
                            $singleActual += '；debug.log 读取失败（可选检查跳过）'
                        }
                    } else {
                        $singleActual += '；debug.log 不存在（可选检查跳过）'
                    }
                }
            } finally {
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
                        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
                    }
                    Start-Sleep -Milliseconds 100
                }
            }
        }
    }
    Add-Result -Name '双开单实例' -Expect '第 1 个窗口启动后，第 2 个进程转交并退出，JingjingReader 进程数 = 1' -Actual $singleActual -Pass $singleOk

    # ── ⑩ 前端产物 ───────────────────────────────────────────────────────────
    Write-Host '[10/10] 前端产物体积与一致性…'
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

    # ── ⑪ 验收报告 ───────────────────────────────────────────────────────────
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
    $reportLines.Add("- 采样间隔：宿主 $HostSampleIntervalMs ms（本次 $memorySamples 次，最大间隔 $hostSampleMaxGapMs ms）/ WebView2 $WebViewSampleIntervalMs ms（本次 $($webViewResult.Samples) 次）")
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
    $reportLines.Add("- 内存判定口径（T17 裁定修正）：宿主进程 ``JingjingReader.exe`` 的 ``PrivateMemorySize64``（Private Bytes）峰值 ≤ $MemoryLimitMb MB；宿主每 $HostSampleIntervalMs ms 采样一次（采样循环内不做 CIM），本次 $memorySamples 个样本、最大间隔 $hostSampleMaxGapMs ms。上限按裁定 2（2026-10-18）由 150 MB 修正为 $MemoryLimitMb MB：WebView2 155 下宿主实测基线 160.6–171.9 MB，原 150 MB 为设计阶段未实测预算，现保留为后续优化目标。")
    $reportLines.Add("- WebView2 基线（信息，独立 runspace 每 $WebViewSampleIntervalMs ms 采样）：" + $webViewBaselineActual + "；统计对象为直接子进程与全部后代的 ``msedgewebview2`` 进程组，取 ``WorkingSet64`` 之和；只记录，不参与 PASS/FAIL。")
    if (($memorySamples -gt 0) -or ($webViewResult.Samples -gt 0)) {
        $reportLines.Add('- 整树 WorkingSet（信息）：峰值 ' + (Format-Mb $peakTreeBytes) + '（同一 WebView2 采样时刻的宿主 `WorkingSet64` + WebView2 进程组求和；仅参考）。')
    }
    $reportLines.Add('- 临时目录：优先 `%TEMP%`；若路径含非 ASCII 字符，依次回退 `%LOCALAPPDATA%\Temp`、脚本所在盘根目录下的 `jj-verify-<guid>`。要求纯 ASCII 的原因：验收启动的 WebView2 子进程会在该目录创建用户数据目录，且 `--verify-*` 的命令行/环境变量在非 ASCII 路径上受系统代码页影响。')
    $reportLines.Add('- 首屏耗时来自前端 `renderDone.elapsedMs`（`--verify-render` 的 READY JSON）；READY 必须满足 `ready`=true、`elapsedMs` 为区间内 Number、`path` 与传入文件一致、`tocCount` 为整数且不低于下限，否则该项 FAIL 并打印原始 READY 行。')
    $reportLines.Add('- 双开单实例检查：先等待第 1 个宿主进程出现，再启动第 2 个；断言第 2 个进程已退出、3 s 后 JingjingReader 进程数为 1，并在 `%APPDATA%\JingjingReader\debug.log` 可读时核对最后一条 `load path=` 等于第 2 个文件。若验收前已有用户正在使用的 JingjingReader 实例，该项会明确失败而不是误杀用户进程。')
    $reportLines.Add('- 宿主单测要求总计 > 0 且失败 0；前端单测要求 `Test Files` 与 `Tests` 的 passed 数均 > 0（零测试不能通过）。')
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
}
