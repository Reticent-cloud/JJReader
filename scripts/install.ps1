#Requires -Version 5.1
<#
鲸鲸阅读器 .md 关联安装脚本（Task 16）。
调用 JingjingReader.exe --install 写入 HKCU\Software\Classes（不需要管理员权限，不写 HKLM），
并提示用户：.md 已有默认程序时需到「设置→默认应用」确认。

用法：
  pwsh -NoProfile -File scripts/install.ps1
  pwsh -NoProfile -File scripts/install.ps1 -ExePath D:\apps\JingjingReader.exe -OpenSettings
#>
[CmdletBinding()]
param(
    # 默认使用构建产物 out\JingjingReader.exe；可显式指定其它位置的 exe。
    # 默认值不能写在 param 块里：Windows PowerShell 5.1 绑定参数时 $PSScriptRoot 还是空串，
    # 会在 Split-Path 处直接失败；放到 param 之后用 $PSCommandPath 解析（5.1/7 都可用）。
    [string]$ExePath,
    # 安装完成后直接打开 Windows「默认应用」设置页。
    [switch]$OpenSettings
)

$ErrorActionPreference = 'Stop'

if (-not $ExePath) {
    $ExePath = Join-Path (Split-Path -Parent $PSCommandPath) '..\out\JingjingReader.exe'
}

# 输出统一 UTF-8：脚本被管道/CI 调用时中文不按系统代码页（GBK）乱码。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Host "未找到程序：$ExePath"
    Write-Host '请先运行 scripts/build.ps1 生成 out\JingjingReader.exe。'
    exit 1
}

# 用管道接收 exe 输出：保证等待进程退出并捕获 --install 打印的中文结果。
& $ExePath --install | ForEach-Object { Write-Host $_ }
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "安装文件关联失败（退出码 $exitCode）。"
    exit $exitCode
}

Write-Host '已注册到 .md 的打开方式。'
Write-Host '若 .md 已有默认程序，请到 设置→默认应用 选择鲸鲸阅读器。'
if ($OpenSettings) {
    Start-Process 'ms-settings:defaultapps'
}

exit 0
