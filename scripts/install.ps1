#Requires -Version 5.1
<#
鲸鲸阅读器安装脚本：先把程序复制到用户目录（默认 %LOCALAPPDATA%\Programs\JingjingReader），
再从安装目录注册 .md 打开方式（只写 HKCU，不需要管理员权限）。

为什么要复制：直接把程序放在源码树、沙箱目录、OneDrive/网络盘等位置运行时，
Windows 的受限安全标签或同步机制可能导致 WebView2 初始化失败（0x800700AA，资源被占用）。

用法：
  pwsh -NoProfile -File scripts/install.ps1                    # 安装到默认目录并注册打开方式
  pwsh -NoProfile -File scripts/install.ps1 -Portable          # 不复制，只注册当前 out\ 里的 exe
  pwsh -NoProfile -File scripts/install.ps1 -InstallDir D:\apps\JingjingReader -OpenSettings
#>
[CmdletBinding()]
param(
    # 源程序（默认找 install.ps1 同目录的 exe，找不到则用源码树的 ..\out\JingjingReader.exe）。
    # 默认值不能写在 param 块里：Windows PowerShell 5.1 绑定参数时 $PSScriptRoot 还是空串。
    [string]$ExePath,
    # 安装目录（默认 %LOCALAPPDATA%\Programs\JingjingReader）。
    [string]$InstallDir,
    # 便携模式：不复制文件，直接用 -ExePath/同目录的 exe 注册关联。
    [switch]$Portable,
    # 安装完成后打开 Windows「默认应用」设置页。
    [switch]$OpenSettings,
    # 安装完成后打开安装目录。
    [switch]$OpenInstallDir
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$scriptDir = Split-Path -Parent $PSCommandPath
if (-not $ExePath) {
    $adjacent = Join-Path $scriptDir 'JingjingReader.exe'
    $ExePath = if (Test-Path -LiteralPath $adjacent -PathType Leaf) {
        $adjacent
    } else {
        Join-Path $scriptDir '..\out\JingjingReader.exe'
    }
}

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Host "未找到程序：$ExePath"
    Write-Host '请先运行 scripts/build.ps1 生成 out\JingjingReader.exe，或用 -ExePath 指定程序位置。'
    exit 1
}

$sourceDir = Split-Path -Parent $ExePath
if ($Portable) {
    $InstallDir = $sourceDir
} elseif (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\JingjingReader'
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
if (-not $Portable) {
    try {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force
    } catch {
        Write-Host "复制程序到安装目录失败：$InstallDir"
        Write-Host $_.Exception.Message
        Write-Host '若程序正在运行，请先关闭；或用 -InstallDir 指定其它可写目录。'
        exit 1
    }

    $ExePath = Join-Path $InstallDir 'JingjingReader.exe'
    Write-Host "已复制程序到：$InstallDir"
}

& $ExePath --install | ForEach-Object { Write-Host $_ }
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "安装文件关联失败（退出码 $exitCode）。"
    exit $exitCode
}

Write-Host ''
Write-Host '安装完成。'
Write-Host "程序位置：$ExePath"
if (-not $Portable) {
    Write-Host '提示：以后请从上面的安装目录启动；不要直接从源码树、沙箱目录或 OneDrive/网络盘运行，否则 WebView2 可能初始化失败（0x800700AA）。'
}
Write-Host '提示：程序未做代码签名，首次运行可能出现「Windows 已保护你的电脑」/SmartScreen 提示；无网络时会显示「无法访问 SmartScreen」，点「运行」即可。'
Write-Host '若 .md 已有默认程序，请到「设置 → 默认应用」选择鲸鲸阅读器。'

if ($OpenInstallDir) {
    Start-Process explorer.exe $InstallDir
}
if ($OpenSettings) {
    Start-Process 'ms-settings:defaultapps'
}

exit 0
