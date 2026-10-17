#Requires -Version 5.1
<#
鲸鲸阅读器构建脚本：web 打包 → 拷贝前端产物 → dotnet publish（单文件）。
默认依赖本机 .NET 10 运行时，产物 out\JingjingReader.exe；
加 -SelfContained 可打包运行时（体积约 100–150 MB），产物 out-selfcontained\JingjingReader.exe，
供没有安装 .NET 10 运行时的电脑使用（首次构建需要能访问 NuGet 运行时包，已缓存的机器可离线）。

用法：
  pwsh -NoProfile -File scripts/build.ps1
  pwsh -NoProfile -File scripts/build.ps1 -SelfContained
#>
[CmdletBinding()]
param(
    # 打包 .NET 运行时（self-contained），输出到 out-selfcontained\，不覆盖默认的 out\。
    [switch]$SelfContained
)

$ErrorActionPreference = 'Stop'

# 输出统一用 UTF-8，避免在管道重定向时中文日志按系统代码页（GBK）输出而乱码。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$Root = Split-Path -Parent $PSScriptRoot
$Web = Join-Path $Root 'web'
$EngineSource = Join-Path $Web 'dist/md-engine.js'
$EngineTarget = Join-Path $Root 'src/Host/Resources/md-engine.js'
$OutDir = if ($SelfContained) { Join-Path $Root 'out-selfcontained' } else { Join-Path $Root 'out' }
$SelfContainedValue = if ($SelfContained) { 'true' } else { 'false' }

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "[build] $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "步骤失败：$Name（退出码 $LASTEXITCODE）"
    }
}

Push-Location $Web
try {
    if (Test-Path (Join-Path $Web 'package-lock.json')) {
        Invoke-Step 'npm ci' { npm ci }
    } else {
        Invoke-Step 'npm install' { npm install }
    }
    Invoke-Step 'npm run build' { npm run build }
} finally {
    Pop-Location
}

Copy-Item -Path $EngineSource -Destination $EngineTarget -Force
Write-Host '[build] 已拷贝 md-engine.js → src/Host/Resources/'

Push-Location $Root
try {
    Invoke-Step 'dotnet publish' {
        dotnet publish 'src/Host/JingjingReader.csproj' -c Release -r win-x64 --self-contained $SelfContainedValue -p:PublishSingleFile=true -o $OutDir
    }
} finally {
    Pop-Location
}

$Exe = Join-Path $OutDir 'JingjingReader.exe'
if (-not (Test-Path $Exe)) {
    throw "构建产物缺失：$Exe"
}
if ($SelfContained) {
    Write-Host "BUILD OK（self-contained）$Exe"
} else {
    Write-Host 'BUILD OK out\JingjingReader.exe'
}
