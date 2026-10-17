#Requires -Version 5.1
<#
鲸鲸阅读器构建脚本：web 打包 → 拷贝前端产物 → dotnet publish（单文件，依赖本机运行时）。
用法：pwsh -NoProfile -File scripts/build.ps1
#>
[CmdletBinding()]
param()

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
$OutDir = Join-Path $Root 'out'

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
        dotnet publish 'src/Host/JingjingReader.csproj' -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o out
    }
} finally {
    Pop-Location
}

$Exe = Join-Path $OutDir 'JingjingReader.exe'
if (-not (Test-Path $Exe)) {
    throw "构建产物缺失：$Exe"
}
Write-Host 'BUILD OK out\JingjingReader.exe'
