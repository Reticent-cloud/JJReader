#Requires -Version 5.1
<#
鲸鲸阅读器卸载脚本：调用 JingjingReader.exe --uninstall 移除 .md 打开方式（恢复安装前备份），
删除安装器写入的「设置 → 应用」卸载项与开始菜单/桌面快捷方式，然后删除安装目录里的程序文件。
用户数据（%APPDATA%\JingjingReader 下的设置/最近/位置）默认保留。

用法：
  pwsh -NoProfile -File scripts/uninstall.ps1                 # 卸载关联并删除默认安装目录
  pwsh -NoProfile -File scripts/uninstall.ps1 -KeepFiles      # 只卸载关联，保留程序文件
  pwsh -NoProfile -File scripts/uninstall.ps1 -InstallDir D:\apps\JingjingReader
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [string]$InstallDir,
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$scriptDir = Split-Path -Parent $PSCommandPath
$defaultInstallDir = Join-Path $env:LOCALAPPDATA 'Programs\JingjingReader'
$hasExplicitInstallDir = $PSBoundParameters.ContainsKey('InstallDir')
if (-not $InstallDir) {
    $InstallDir = $defaultInstallDir
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

if (-not $ExePath) {
    $fromInstallDir = Join-Path $InstallDir 'JingjingReader.exe'
    $adjacent = Join-Path $scriptDir 'JingjingReader.exe'
    $defaultInstalled = Join-Path $defaultInstallDir 'JingjingReader.exe'
    $sourceTree = Join-Path $scriptDir '..\out\JingjingReader.exe'
    if ($hasExplicitInstallDir) {
        # 显式指定安装目录：只认该目录，找不到就让下面的检查报错（不误删其它安装）。
        $ExePath = $fromInstallDir
    } else {
        # 无参数时优先脚本同目录：安装器写入的 UninstallString 不带 -InstallDir，
        # 自定义安装目录的卸载不能误删默认目录里的另一个安装。
        $ExePath = if (Test-Path -LiteralPath $adjacent -PathType Leaf) {
            $adjacent
        } elseif (Test-Path -LiteralPath $fromInstallDir -PathType Leaf) {
            $fromInstallDir
        } elseif (Test-Path -LiteralPath $defaultInstalled -PathType Leaf) {
            $defaultInstalled
        } else {
            $sourceTree
        }
    }
}

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Host "未找到程序：$ExePath"
    Write-Host '卸载需要运行 JingjingReader.exe --uninstall；请用 -ExePath 指定程序位置。'
    exit 1
}

& $ExePath --uninstall | ForEach-Object { Write-Host $_ }
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "卸载文件关联失败（退出码 $exitCode）。"
    exit $exitCode
}

# 安装器写入的「设置 → 应用」卸载项与开始菜单/桌面快捷方式：卸载成功即删除。
# -KeepFiles 只保留程序文件，不再保留「已安装应用」的注册与快捷方式。
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JingjingReader'
try {
    if (Test-Path -LiteralPath $uninstallKey) {
        Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction Stop
        Write-Host '已删除「设置 → 应用」里的卸载项。'
    }
} catch {
    Write-Host "无法删除卸载项（$uninstallKey）：$($_.Exception.Message)"
    Write-Host '如需要，可在注册表编辑器中手动删除该键。'
}

$shortcutPaths = @()
$programsDir = [Environment]::GetFolderPath('Programs')
if ($programsDir) {
    $shortcutPaths += Join-Path $programsDir '鲸鲸阅读器.lnk'
}
$desktopDir = [Environment]::GetFolderPath('Desktop')
if ($desktopDir) {
    $shortcutPaths += Join-Path $desktopDir '鲸鲸阅读器.lnk'
}
foreach ($shortcutPath in $shortcutPaths) {
    try {
        if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop
            Write-Host "已删除快捷方式：$shortcutPath"
        }
    } catch {
        Write-Host "无法删除快捷方式：$shortcutPath"
        Write-Host $_.Exception.Message
    }
}

if (-not $KeepFiles) {
    $exeDir = Split-Path -Parent $ExePath
    if ($exeDir -and (Test-Path -LiteralPath $exeDir -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $exeDir 'JingjingReader.exe') -PathType Leaf)) {
        try {
            Remove-Item -LiteralPath $exeDir -Recurse -Force
            Write-Host "已删除程序文件：$exeDir"
        } catch {
            Write-Host "无法自动删除程序文件：$exeDir"
            Write-Host $_.Exception.Message
            Write-Host '若程序仍在运行，请先关闭再手动删除该目录。'
        }
    }
}

Write-Host '卸载完成：已移除「鲸鲸阅读器」的 .md 打开方式（恢复结果见上）。'
Write-Host '已删除「设置 → 应用」卸载项与开始菜单/桌面快捷方式（若存在）。'
Write-Host "用户数据保留在：$env:APPDATA\JingjingReader（设置/最近文件/阅读位置；不需要可手动删除）。"
Write-Host '提示：若之前把鲸鲸阅读器设为 .md 默认程序，Windows 的「默认应用」关联需你在 设置→默认应用 里重新选择其它程序。'
exit 0
