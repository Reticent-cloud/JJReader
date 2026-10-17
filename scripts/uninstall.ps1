#Requires -Version 5.1
<#
鲸鲸阅读器 .md 关联卸载脚本（Task 16）。
调用 JingjingReader.exe --uninstall：删除 HKCU 下的 ProgID/OpenWithProgids 值，
并按 assoc-backup.json 恢复安装前的 .md 默认程序（备份缺失时尽力删除本程序写入的键值）。

用法：
  pwsh -NoProfile -File scripts/uninstall.ps1
  pwsh -NoProfile -File scripts/uninstall.ps1 -ExePath D:\apps\JingjingReader.exe
#>
[CmdletBinding()]
param(
    # 默认使用构建产物 out\JingjingReader.exe；可显式指定其它位置的 exe。
    [string]$ExePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out\JingjingReader.exe')
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Host "未找到程序：$ExePath"
    Write-Host '卸载需要运行 JingjingReader.exe --uninstall；请先构建或指定 -ExePath。'
    exit 1
}

# 用管道接收 exe 输出：保证等待进程退出并捕获 --uninstall 打印的中文结果（含备份恢复情况）。
& $ExePath --uninstall | ForEach-Object { Write-Host $_ }
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host "卸载文件关联失败（退出码 $exitCode）。"
    exit $exitCode
}

Write-Host '卸载完成：已移除「鲸鲸阅读器」的 .md 打开方式；若存在备份，.md 默认程序已恢复为安装前的值。'
exit 0
