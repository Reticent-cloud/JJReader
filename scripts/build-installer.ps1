#Requires -Version 5.1
<#
鲸鲸阅读器安装包构建脚本：
  1. 运行 scripts/build.ps1（确保 out\ 是最新的分发包）；
  2. dotnet publish installer/JingjingReaderUninstall（Release、win-x64、框架依赖、单文件），
     把「卸载鲸鲸阅读器.exe」放进 out\；
  3. 用 Compress-Archive 把 out\* 打成 installer/JingjingReaderSetup/payload.zip（含卸载器）；
  4. dotnet publish installer/JingjingReaderSetup（Release、win-x64、框架依赖、单文件）；
  5. 输出 dist\JingjingReaderSetup.exe，并复制一份「卸载鲸鲸阅读器.exe」到 dist\ 便于查看。

安装器把 payload.zip 作为 EmbeddedResource 嵌进 exe；payload.zip 是构建产物（git 忽略），
构建前必须存在（本脚本负责生成）。安装后卸载器位于 <安装目录>\卸载鲸鲸阅读器.exe。

用法：
  pwsh -NoProfile -File scripts/build-installer.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1

后续（未实现）：-SelfContained 可把安装器自身也打成自包含，代价是体积增加约 130 MB。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# 输出统一 UTF-8，避免在管道重定向时中文日志按系统代码页（GBK）输出而乱码。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    Write-Verbose '无法设置控制台输出编码，沿用默认值'
}

$Root = Split-Path -Parent $PSScriptRoot
$BuildScript = Join-Path $PSScriptRoot 'build.ps1'
$OutDir = Join-Path $Root 'out'
$UninstallerProject = Join-Path $Root 'installer/JingjingReaderUninstall/JingjingReaderUninstall.csproj'
$SetupProject = Join-Path $Root 'installer/JingjingReaderSetup/JingjingReaderSetup.csproj'
$Payload = Join-Path $Root 'installer/JingjingReaderSetup/payload.zip'
$DistDir = Join-Path $Root 'dist'
$DistExe = Join-Path $DistDir 'JingjingReaderSetup.exe'
$UninstallerFileName = '卸载鲸鲸阅读器.exe'
$OutUninstaller = Join-Path $OutDir $UninstallerFileName
$DistUninstaller = Join-Path $DistDir $UninstallerFileName
$RequiredFiles = @('JingjingReader.exe', 'install.ps1', 'uninstall.ps1', $UninstallerFileName, 'README.md')

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "[installer] $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "步骤失败：$Name（退出码 $LASTEXITCODE）"
    }
}

if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
    throw "构建脚本缺失：$BuildScript"
}

Invoke-Step '构建应用（scripts/build.ps1）' { & $BuildScript }

Push-Location $Root
try {
    Invoke-Step 'dotnet publish 卸载器（单文件、框架依赖）' {
        dotnet publish $UninstallerProject `
            -c Release `
            -r win-x64 `
            --self-contained false `
            -p:PublishSingleFile=true `
            -p:IncludeNativeLibrariesForSelfExtract=true `
            -p:DebugType=None `
            -p:DebugSymbols=false `
            -o $OutDir
    }
} finally {
    Pop-Location
}

foreach ($item in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $OutDir $item) -PathType Leaf)) {
        throw "分发包不完整：$OutDir\$item 缺失；请检查 scripts/build.ps1 与卸载器构建步骤"
    }
}

if (Test-Path -LiteralPath $Payload) {
    Remove-Item -LiteralPath $Payload -Force
}
Invoke-Step '打包 payload.zip（out\*）' {
    Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $Payload -CompressionLevel Optimal -Force
}
if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) {
    throw "payload.zip 未生成：$Payload"
}
$payloadBytes = (Get-Item -LiteralPath $Payload).Length
Write-Host ('[installer] payload.zip：{0:N2} MB' -f ($payloadBytes / 1MB))

# 清空 dist\（保留目录本身），避免上一次构建的残留文件混入发布目录。
if (Test-Path -LiteralPath $DistDir) {
    Get-ChildItem -LiteralPath $DistDir -Force | Remove-Item -Recurse -Force
} else {
    $null = New-Item -ItemType Directory -Path $DistDir -Force
}

Push-Location $Root
try {
    Invoke-Step 'dotnet publish 安装器（单文件、框架依赖）' {
        dotnet publish 'installer/JingjingReaderSetup/JingjingReaderSetup.csproj' `
            -c Release `
            -r win-x64 `
            --self-contained false `
            -p:PublishSingleFile=true `
            -p:IncludeNativeLibrariesForSelfExtract=true `
            -p:DebugType=None `
            -p:DebugSymbols=false `
            -o $DistDir
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $DistExe -PathType Leaf)) {
    throw "安装包产物缺失：$DistExe"
}

# 可选但便于直接查看/测试：dist\ 里也放一份卸载器（安装包内仍以 payload 中的为准）。
Copy-Item -LiteralPath $OutUninstaller -Destination $DistUninstaller -Force
if (-not (Test-Path -LiteralPath $DistUninstaller -PathType Leaf)) {
    throw "卸载器产物缺失：$DistUninstaller"
}

$exeBytes = (Get-Item -LiteralPath $DistExe).Length
$uninstallerBytes = (Get-Item -LiteralPath $DistUninstaller).Length
Write-Host ('[installer] 产物：dist\JingjingReaderSetup.exe（{0:N2} MB，payload {1:N2} MB）' -f ($exeBytes / 1MB), ($payloadBytes / 1MB))
Write-Host ('[installer] 产物：dist\卸载鲸鲸阅读器.exe（{0:N2} MB）' -f ($uninstallerBytes / 1MB))
Write-Host 'BUILD INSTALLER OK dist\JingjingReaderSetup.exe'
