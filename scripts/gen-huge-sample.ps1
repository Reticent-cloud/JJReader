#Requires -Version 5.1
<#
鲸鲸阅读器大文档性能样本生成器（Task 11）。
生成 samples/huge-50k-lines.md：恰好 5 万行、约 2–4 MB，混合标题、代码块、表格与任务清单，
用于验收分块渲染与大文件模式（5 万行文档首屏 ≤ 1.5 s）。

用法：
    pwsh -NoProfile -File scripts/gen-huge-sample.ps1            # 已存在时跳过
    pwsh -NoProfile -File scripts/gen-huge-sample.ps1 -Force     # 覆盖已有样本
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 输出统一 UTF-8，避免管道重定向时中文日志按系统代码页（GBK）输出而乱码。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$Root = Split-Path -Parent $PSScriptRoot
$SampleDir = Join-Path $Root 'samples'
$Target = Join-Path $SampleDir 'huge-50k-lines.md'

# 5 万行 = 250 段 × 200 行/段；每段固定模板 + 列表项填充，保证行数可精确复现。
$SegmentLines = 200
$SegmentCount = 250
$TotalLines = $SegmentLines * $SegmentCount

if ((Test-Path $Target) -and -not $Force) {
    Write-Host "[gen-huge] 已存在，跳过：$Target（需要覆盖请加 -Force）"
    return
}

New-Item -ItemType Directory -Force -Path $SampleDir | Out-Null

$lines = [System.Collections.Generic.List[string]]::new($TotalLines)

for ($segment = 1; $segment -le $SegmentCount; $segment++) {
    $count = 0

    # 每段模板（19 行）：标题 + 说明 + 代码块 + 表格 + 任务清单 + 空行
    $template = @(
        "# 第 $segment 章 大文档性能样本",
        '',
        '## 本章要点',
        '',
        '本章用于验证分块渲染、首屏耗时与大文件模式；内容混合代码块、表格与任务清单，贴近真实笔记。',
        '',
        '```js',
        "const chapter = $segment;",
        'const message = "鲸鲸阅读器 分块渲染";',
        'console.log(message, chapter);',
        '```',
        '',
        '| 指标 | 目标 | 实测 |',
        '| --- | --- | --- |',
        '| 首屏耗时 | ≤1.5 s | 待填 |',
        '| 前端产物 | ≤500 KB | 待填 |',
        '',
        '- [x] 分块渲染首屏只渲染预算内块',
        '- [ ] TOC 点击未渲染标题时先 renderAll'
    )
    foreach ($line in $template) {
        $lines.Add($line)
        $count++
    }
    $lines.Add('')
    $count++

    # 其余行用列表项 + 空行填充（松散列表，贴近真实笔记，也让段落/列表结构参与切块）
    $item = 0
    while ($count -lt $SegmentLines) {
        $item++
        $lines.Add("- 第 $segment-$item 项：鲸鲸阅读器大文档分块渲染样本，用于首屏耗时与滚动流畅度验收。")
        $count++
        if ($count -lt $SegmentLines) {
            $lines.Add('')
            $count++
        }
    }
}

if ($lines.Count -ne $TotalLines) {
    throw "样本行数不符：实际 $($lines.Count)，期望 $TotalLines"
}

# 无 BOM UTF-8（宿主与引擎都按 UTF-8 读取；BOM 会变成正文首字符）
[System.IO.File]::WriteAllLines($Target, $lines, [System.Text.UTF8Encoding]::new($false))

$file = Get-Item -LiteralPath $Target
$sizeKb = [math]::Round($file.Length / 1KB, 1)
Write-Host "[gen-huge] 已生成：$Target"
Write-Host "[gen-huge] 行数：$($lines.Count)，体积：$sizeKb KB"
if ($file.Length -lt 2MB -or $file.Length -gt 4MB) {
    Write-Warning "[gen-huge] 样本体积 $sizeKb KB 不在建议的 2–4 MB 区间（请检查模板内容）"
}
