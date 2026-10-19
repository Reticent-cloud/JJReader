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

# 安装目录里的「卸载鲸鲸阅读器.exe」会把脚本复制到 %TEMP%\jj-uninstall-<guid>\ 再启动；
# 此时脚本不能立即删除安装目录（卸载器 exe 还在运行），要等调用者退出。
$tempRoot = [System.IO.Path]::GetTempPath().TrimEnd('\', '/')
$scriptParent = (Split-Path -Parent $scriptDir).TrimEnd('\', '/')
$isFromTemp = [string]::Equals($scriptParent, $tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    ((Split-Path -Leaf $scriptDir) -like 'jj-uninstall-*')

# 从临时目录运行时写一份日志供排查；成功删除安装目录后临时目录会自清理（失败则保留）。
$transcriptPath = $null
if ($isFromTemp) {
    $transcriptPath = Join-Path $scriptDir 'uninstall.log'
    try {
        Start-Transcript -Path $transcriptPath -Force | Out-Null
    } catch {
        $transcriptPath = $null
        Write-Verbose "无法创建卸载日志：$($_.Exception.Message)"
    }
}

function Stop-UninstallTranscript {
    if ($script:transcriptPath) {
        try {
            Stop-Transcript | Out-Null
        } catch {
            Write-Verbose '停止卸载日志失败，已忽略'
        }
        $script:transcriptPath = $null
    }
}

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
    Stop-UninstallTranscript
    exit 1
}

& $ExePath --uninstall | ForEach-Object { Write-Host $_ }
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "卸载文件关联失败（退出码 $exitCode）。"
    Stop-UninstallTranscript
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

$deleteFailed = $false
$deletedDirectory = $null
if (-not $KeepFiles) {
    # 从临时目录运行时删除 -InstallDir；否则沿用既有语义删除 exe 所在目录。
    $deleteDir = if ($isFromTemp) { $InstallDir } else { Split-Path -Parent $ExePath }
    if ($deleteDir -and (Test-Path -LiteralPath $deleteDir -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $deleteDir 'JingjingReader.exe') -PathType Leaf)) {
        $deleted = $false
        $lastError = $null

        if ($isFromTemp) {
            # 卸载器 exe 正在退出：最多等 5 秒（20 × 250ms），等文件占用释放后再删。
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                if (-not (Test-Path -LiteralPath $deleteDir -PathType Container)) {
                    $deleted = $true
                    break
                }

                try {
                    Remove-Item -LiteralPath $deleteDir -Recurse -Force -ErrorAction Stop
                    $deleted = $true
                    break
                } catch {
                    $lastError = $_.Exception.Message
                    if ($attempt -lt 19) {
                        Start-Sleep -Milliseconds 250
                    }
                }
            }
        } else {
            try {
                Remove-Item -LiteralPath $deleteDir -Recurse -Force -ErrorAction Stop
                $deleted = $true
            } catch {
                $lastError = $_.Exception.Message
            }
        }

        if ($deleted) {
            Write-Host "已删除程序文件：$deleteDir"
            $deletedDirectory = $deleteDir
        } else {
            $deleteFailed = $true
            Write-Host "无法自动删除程序文件：$deleteDir"
            if ($lastError) {
                Write-Host $lastError
            }
            Write-Host '请关闭仍在运行的程序后手动删除该目录。'
        }
    }
}

# 从临时目录运行时，成功删除安装目录后清理脚本自身；失败则保留日志供排查。
if ($isFromTemp -and $deletedDirectory) {
    Stop-UninstallTranscript
    try {
        if (Test-Path -LiteralPath $scriptDir -PathType Container) {
            Remove-Item -LiteralPath $scriptDir -Recurse -Force -ErrorAction Stop
        }
    } catch {
        Write-Host "无法清理临时目录：$scriptDir"
        Write-Host $_.Exception.Message
    }
} else {
    Stop-UninstallTranscript
}

Write-Host '卸载完成：已移除「鲸鲸阅读器」的 .md 打开方式（恢复结果见上）。'
Write-Host '已删除「设置 → 应用」卸载项与开始菜单/桌面快捷方式（若存在）。'
if ($deletedDirectory) {
    Write-Host '程序文件已删除。'
}
Write-Host "用户数据保留在：$env:APPDATA\JingjingReader（设置/最近文件/阅读位置；不需要可手动删除）。"
Write-Host '提示：若之前把鲸鲸阅读器设为 .md 默认程序，Windows 的「默认应用」关联需你在 设置→默认应用 里重新选择其它程序。'

if ($deleteFailed) {
    exit 1
}
exit 0
