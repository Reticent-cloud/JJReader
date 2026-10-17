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
  7. --verify-render samples/huge-50k-lines.md：首屏 ≤ 1500 ms + 宿主私有内存峰值 ≤ 200 MB
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
  - 临时目录位于 %TEMP%\jj-verify-<guid>（ASCII），结束后清理；只停止本脚本启动的宿主进程。

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
# 裁定 2（2026-10-18）：宿主私有内存上限 200 MB；150 MB 保留为优化目标。
$MemoryLimitBytes = 200 * $MB
$PdfHelloLimitBytes = 5 * 1024
$PdfHugeLimitBytes = 1 * $MB
$ArtifactLimitBytes = 500 * 1024

$Results = New-Object System.Collections.ArrayList
$Failures = 0
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('jj-verify-' + [guid]::NewGuid().ToString('N'))
$Exe = $null
$SelftestText = ''
$OurHostPids = New-Object 'System.Collections.Generic.HashSet[int]'
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
    $null = $OurHostPids.Add([int]$process.Id)

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

function Find-ReadyJson {
    param([string]$Text)
    $match = [regex]::Match($Text, '(?m)^READY\s+(\{.*\})\s*$')
    if (-not $match.Success) { return $null }
    try {
        return ($match.Groups[1].Value | ConvertFrom-Json)
    } catch {
        return $null
    }
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

function Stop-OurProcesses {
    # 只停止「可执行文件路径位于本次临时目录」的 JingjingReader 进程；绝不碰用户其它实例。
    if (-not $Exe) { return }
    $processes = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        try {
            $path = $process.Path
        } catch {
            $path = $null
        }
        if ($path -and ($path -eq $Exe)) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    # 由本次启动的宿主拉起的 WebView2 子进程：父 PID 仍在记录里才停（防止误杀用户的 WebView2）。
    try {
        $webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue)
        foreach ($webview in $webviews) {
            if ($OurHostPids.Contains([int]$webview.ParentProcessId)) {
                try { Stop-Process -Id ([int]$webview.ProcessId) -Force -ErrorAction SilentlyContinue } catch { }
            }
        }
    } catch {
        # CIM 不可用（极简系统）：父进程退出后 WebView2 一般会自行退出，不阻断验收。
    }
}

# ── 预检：目录/工具链存在 ─────────────────────────────────────────────────────

New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $TempRoot 'pdf') -Force | Out-Null

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
Write-Host "仓库：$Root"
Write-Host "临时目录：$TempRoot"
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
        # 兜底满足任务书口径：解析控制台输出的「失败: 0」/「Failed: 0」。
        $textSaysGreen = ($hostText -match '失败:\s*0|Failed:\s*0')
        if ($null -ne $failedCount) {
            $hostTestOk = ($dotnetTest.ExitCode -eq 0) -and ($failedCount -eq 0)
            $hostTestActual = "失败 $failedCount / 通过 $passedCount / 总计 $totalCount（TRX）"
        } else {
            $hostTestOk = ($dotnetTest.ExitCode -eq 0) -and $textSaysGreen
            $hostTestActual = "exit $($dotnetTest.ExitCode)；" + (Get-ShortText (($hostText -split "`r?`n" | Where-Object { $_ -match '通过|Passed|失败|Failed' } | Select-Object -Last 3) -join ' | ') 300)
        }
        if (-not $hostTestOk -and $dotnetTest.TimedOut) {
            $hostTestActual = '测试超时（> 15 分钟）'
        }
    }
    Add-Result -Name '宿主单测' -Expect 'dotnet test 全绿（失败 0）' -Actual $hostTestActual -Pass $hostTestOk

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
        $testFiles = Get-MatchValue $webText 'Test Files\s+(\d+)\s+passed'
        $testCount = Get-MatchValue $webText 'Tests\s+(\d+)\s+passed'
        $hasFailedSummary = ($webText -match 'Tests\s+\d+\s+failed')
        $webTestOk = ($webTest.ExitCode -eq 0) -and ($testCount -ne '') -and (-not $hasFailedSummary)
        $webTestActual = "exit $($webTest.ExitCode)；Test Files $testFiles passed / Tests $testCount passed"
        if (-not $webTestOk) {
            $webTestActual += '；' + (Get-ShortText (($webText -split "`r?`n" | Where-Object { $_ -match 'FAIL|failed|Error' } | Select-Object -Last 3) -join ' | ') 300)
        }
    }
    Add-Result -Name '前端单测' -Expect 'web/npm test 全绿' -Actual $webTestActual -Pass $webTestOk

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
    Add-Result -Name 'ASCII 运行副本' -Expect 'out\ 完整复制到 %TEMP%\jj-verify-<guid>' -Actual $copyActual -Pass $copyOk

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
        $renderFull = Invoke-Captured -FilePath $Exe -WorkingDirectory $TempRoot -TimeoutMs 60000 `
            -Arguments @('--verify-render', (Join-Path $TempRoot 'full-syntax.md'))
        $ready = Find-ReadyJson $renderFull.StdOut
        if ($null -ne $ready) {
            $fullElapsed = [long]$ready.elapsedMs
            $tocCount = [int]$ready.tocCount
            $fullOk = ($renderFull.ExitCode -eq 0) -and [bool]$ready.ready -and ($fullElapsed -le 1000) -and ($tocCount -ge 30)
            $fullActual = "elapsedMs=$fullElapsed（≤ 1000）、tocCount=$tocCount（≥ 30）、exit $($renderFull.ExitCode)"
        } else {
            $fullActual = "未解析到 READY JSON；exit $($renderFull.ExitCode)；" + (Get-ShortText ($renderFull.StdOut + ' ' + $renderFull.StdErr) 300)
        }
    }
    Add-Result -Name 'full-syntax 首屏' -Expect 'elapsedMs ≤ 1000 ms，tocCount ≥ 30' -Actual $fullActual -Pass $fullOk

    # ── ⑦ 5 万行首屏 + 宿主私有内存峰值（WebView2 进程组仅作信息项）──────────
    Write-Host '[7/10] 5 万行首屏与内存峰值（--verify-render + 宿主私有内存采样）…'
    $hugeElapsed = $null
    $hugeReadyOk = $false
    $hugeActual = ''
    $peakPrivateBytes = [long]0
    $peakWebViewBytes = [long]0
    $peakWebViewCount = 0
    $peakTreeBytes = [long]0
    $memorySamples = 0
    $memoryOk = $false
    $memoryActual = ''
    $webViewBaselineActual = '跳过：运行副本缺失'
    if (-not $canRunHost) {
        $hugeActual = '跳过：运行副本缺失'
        $memoryActual = '跳过：运行副本缺失'
    } else {
        $hugeOut = Join-Path $TempRoot 'log-render-huge.out.txt'
        $hugeErr = Join-Path $TempRoot 'log-render-huge.err.txt'
        $hugeArgs = @('--verify-render', (Quote-Argument (Join-Path $TempRoot 'huge-50k-lines.md')))
        $params = @{
            FilePath               = $Exe
            WorkingDirectory       = $TempRoot
            PassThru               = $true
            RedirectStandardOutput = $hugeOut
            RedirectStandardError  = $hugeErr
            NoNewWindow            = $true
            ArgumentList           = $hugeArgs
        }
        $hugeProcess = Start-Process @params
        $null = $OurHostPids.Add([int]$hugeProcess.Id)
        $deadline = (Get-Date).AddSeconds(180)
        $timedOut = $false
        Start-Sleep -Milliseconds 20
        while ($true) {
            $hostProcess = Get-Process -Id $hugeProcess.Id -ErrorAction SilentlyContinue
            $samplePrivate = [long]0
            $sampleHostWs = [long]0
            if ($hostProcess) {
                try { $samplePrivate = [long]$hostProcess.PrivateMemorySize64 } catch { $samplePrivate = [long]0 }
                try { $sampleHostWs = [long]$hostProcess.WorkingSet64 } catch { $sampleHostWs = [long]0 }
            }
            $webViewGroup = Get-WebViewGroupWorkingSet -RootProcessId ([int]$hugeProcess.Id)
            $sampleTreeWs = $sampleHostWs + [long]$webViewGroup.Bytes
            if (($samplePrivate -gt 0) -or ($sampleHostWs -gt 0) -or ([long]$webViewGroup.Bytes -gt 0)) {
                $memorySamples += 1
                # 判定值：宿主进程 PrivateMemorySize64（Private Bytes）单独取峰值。
                if ($samplePrivate -gt $peakPrivateBytes) { $peakPrivateBytes = $samplePrivate }
                # 信息项各自取峰值；整树峰值按同一采样时刻求和，避免相加两个不同时刻的峰值。
                if ([long]$webViewGroup.Bytes -gt $peakWebViewBytes) {
                    $peakWebViewBytes = [long]$webViewGroup.Bytes
                    $peakWebViewCount = [int]$webViewGroup.Count
                }
                if ($sampleTreeWs -gt $peakTreeBytes) { $peakTreeBytes = $sampleTreeWs }
            }
            if ($hugeProcess.HasExited) { break }
            if ((Get-Date) -gt $deadline) {
                $timedOut = $true
                try { $hugeProcess.Kill() } catch { }
                break
            }
            Start-Sleep -Milliseconds 50
        }
        try { $null = $hugeProcess.WaitForExit(10000) } catch { }
        $hugeExitCode = -1
        try {
            if ($hugeProcess.HasExited) { $hugeExitCode = $hugeProcess.ExitCode }
        } catch {
            $hugeExitCode = -1
        }

        $hugeStdOut = Read-Utf8File $hugeOut
        $ready = Find-ReadyJson $hugeStdOut
        if ($null -ne $ready) {
            $hugeElapsed = [long]$ready.elapsedMs
            $hugeToc = [int]$ready.tocCount
            # Windows PowerShell 5.1 的 Start-Process -PassThru 取不到 ExitCode，成功口径以 READY JSON 为准。
            $hugeReadyOk = ((-not $timedOut) -and [bool]$ready.ready -and ($hugeElapsed -le 1500))
            $hugeActual = "elapsedMs=$hugeElapsed（≤ 1500）、tocCount=$hugeToc、exit 0（READY）"
        } else {
            $hugeActual = "未解析到 READY JSON；exit $hugeExitCode；超时=$timedOut；" + `
                (Get-ShortText ($hugeStdOut + ' ' + (Read-Utf8File $hugeErr)) 300)
        }

        $memoryOk = (-not $timedOut) -and ($peakPrivateBytes -gt 0) -and ($peakPrivateBytes -le $MemoryLimitBytes)
        if ($memorySamples -eq 0) {
            $memoryActual = '未采集到内存样本（进程退出过快或无法读取进程）'
            $webViewBaselineActual = '未采集到内存样本'
        } else {
            $memoryActual = "峰值 $(Format-Mb $peakPrivateBytes)（≤ 200.0 MB；PrivateMemorySize64，采样 $memorySamples 次）"
            $webViewBaselineActual = "峰值 $(Format-Mb $peakWebViewBytes)（$peakWebViewCount 个 msedgewebview2 进程；50 ms 采样 $memorySamples 次）"
        }
    }
    Add-Result -Name '5 万行首屏' -Expect 'elapsedMs ≤ 1500 ms' -Actual $hugeActual -Pass $hugeReadyOk
    Add-Result -Name '宿主私有内存峰值（≤200MB）' -Expect 'JingjingReader.exe PrivateMemorySize64 峰值 ≤ 200 MB' -Actual $memoryActual -Pass $memoryOk
    if ($memorySamples -gt 0) {
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
            try {
                $firstParams = @{
                    FilePath         = $Exe
                    WorkingDirectory = $TempRoot
                    PassThru         = $true
                    ArgumentList     = @((Quote-Argument (Join-Path $TempRoot 'hello.md')))
                }
                $first = Start-Process @firstParams
                $null = $OurHostPids.Add([int]$first.Id)
                Start-Sleep -Seconds 2
                $secondParams = @{
                    FilePath         = $Exe
                    WorkingDirectory = $TempRoot
                    PassThru         = $true
                    ArgumentList     = @((Quote-Argument (Join-Path $TempRoot 'full-syntax.md')))
                }
                $second = Start-Process @secondParams
                $null = $OurHostPids.Add([int]$second.Id)
                Start-Sleep -Seconds 3
                $instances = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue)
                $singleOk = ($instances.Count -eq 1)
                $singleActual = "启动两个进程后 JingjingReader 进程数 = $($instances.Count)（期望 1）"
            } finally {
                # 只清理本脚本启动的副本；WebView2 子进程随宿主退出。
                if ($first) {
                    try { Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue } catch { }
                }
                if ($second) {
                    try { Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue } catch { }
                }
                $count = 0
                while ($count -lt 20) {
                    $remaining = @(Get-Process -Name 'JingjingReader' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe })
                    if ($remaining.Count -eq 0) { break }
                    foreach ($process in $remaining) {
                        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { }
                    }
                    $count += 1
                    Start-Sleep -Milliseconds 100
                }
            }
        }
    }
    Add-Result -Name '双开单实例' -Expect '两个宿主进程并发启动后 JingjingReader 进程数 = 1' -Actual $singleActual -Pass $singleOk

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
    $reportLines.Add("- 运行副本：$TempRoot（ASCII 临时目录；验收后清理）")
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
    $reportLines.Add('- 内存判定口径（T17 裁定修正）：宿主进程 `JingjingReader.exe` 的 `PrivateMemorySize64`（Private Bytes，`Get-Process -Id <pid> | Select PrivateMemorySize64`）峰值 ≤ 200 MB，50 ms 采样取峰值。上限按裁定 2（2026-10-18）由 150 MB 修正为 200 MB：WebView2 155 下宿主实测基线 160.6–171.9 MB，原 150 MB 为设计阶段未实测预算，现保留为后续优化目标。')
    $reportLines.Add('- WebView2 基线（信息）：' + $webViewBaselineActual + '；统计对象为直接子进程与全部后代的 `msedgewebview2` 进程组，取 `WorkingSet64` 之和；只记录，不参与 PASS/FAIL。')
    if ($memorySamples -gt 0) {
        $reportLines.Add('- 整树 WorkingSet（信息）：峰值 ' + (Format-Mb $peakTreeBytes) + '（宿主 `WorkingSet64` + WebView2 进程组，同一采样时刻求和；仅参考）。')
    }
    $reportLines.Add('- 首屏耗时来自前端 `renderDone.elapsedMs`（`--verify-render` 的 READY JSON）；PDF 页数按字节层 `/Type /Page` 对象统计（排除 `/Type /Pages`）。')
    $reportLines.Add('- 双开单实例检查用同一份副本 exe 启动两个进程；若验收前已有用户正在使用的 JingjingReader 实例，该项会明确失败而不是误杀用户进程。')
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
