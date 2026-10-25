<#
.SYNOPSIS
    XLSX 技能环境预检（Windows）。

.DESCRIPTION
    按 <EXE>_PATH -> 当前 PATH -> 注册表 PATH -> 标准安装位置的顺序解析每个工具，
    避免把「已安装但不在 PATH」误判成「缺失」。报告写到 stderr，PATH 修正值以
    PATH_FIX=<目录> 单行写到 stdout，由调用方解析后拼接（不经 Invoke-Expression）：

        $fix = & scripts\check_environment.ps1
        if ($fix -like 'PATH_FIX=*') { $env:Path = $fix.Substring(9) + ';' + $env:Path }

    退出码：0 = 通过（可能带警告），1 = 有必需项缺失。
    macOS / Linux 用同目录的 check_environment.sh。
#>

[CmdletBinding()]
param(
    [string]$PythonBin = 'python'
)

$MinPython = [Version]'3.10'

$PyModules = @(
    @{ Module = 'openpyxl'; Dist = 'openpyxl'; Required = $true }
    @{ Module = 'pandas';   Dist = 'pandas';   Required = $false }
    @{ Module = 'PIL';      Dist = 'Pillow';   Required = $false }
)

$Tools = @(
    @{ Exe = 'soffice'; Component = 'LibreOffice'; Purpose = '动态公式验证'; Required = $false
       Install = 'winget install --source winget --exact --id TheDocumentFoundation.LibreOffice' }
)

function Write-Report([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

# 注册表里那份持久化的 Machine + User PATH；沙箱继承的 $env:Path 常常比它少。
function Get-RegistryPathDirs {
    $keys = @(
        'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
        'HKCU:\Environment'
    )
    $dirs = @()
    foreach ($key in $keys) {
        try {
            $value = (Get-ItemProperty -Path $key -Name Path -ErrorAction Stop).Path
        } catch {
            continue
        }
        $dirs += [Environment]::ExpandEnvironmentVariables($value) -split ';' | Where-Object { $_ }
    }
    return $dirs
}

function Get-SearchRoots {
    $roots = @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})
    if ($env:LOCALAPPDATA) {
        $roots += Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        $roots += Join-Path $env:LOCALAPPDATA 'Programs'
    }
    return $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

function Find-Tool([string]$Exe, [string[]]$ExtraDirs) {
    $override = [Environment]::GetEnvironmentVariable(($Exe.ToUpper() -replace '-', '_') + '_PATH')
    if ($override -and (Test-Path $override -PathType Leaf)) { return $override }

    $command = Get-Command $Exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    foreach ($dir in $ExtraDirs) {
        $candidate = Join-Path $dir "$Exe.exe"
        if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }

    foreach ($root in Get-SearchRoots) {
        $hit = Get-ChildItem -Path $root -Filter "$Exe.exe" -Recurse -Depth 4 -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$failures = 0
$warnings = 0
$missingPython = @()
$missingTools = @()
$pathFix = @()

Write-Report "XLSX 环境预检（Windows $env:PROCESSOR_ARCHITECTURE）"

$python = Get-Command $PythonBin -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Report "[缺失] 未找到 $PythonBin；请安装 Python $MinPython+ 或用 -PythonBin 指定"
    Write-Report ''
    Write-Report '结果：1 个失败，0 个警告；环境预检未通过。'
    exit 1
}

$version = [Version](& $PythonBin -c 'import platform; print(platform.python_version())')
if ($version -ge $MinPython) {
    Write-Report "[就绪] Python $version ($($python.Source))"
} else {
    $failures++
    Write-Report "[缺失] Python 需要 $MinPython+，当前 $version"
}

foreach ($item in $PyModules) {
    & $PythonBin -c "import $($item.Module)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Report "[就绪] Python 库 $($item.Dist)"
    } elseif ($item.Required) {
        $failures++
        $missingPython += $item.Dist
        Write-Report "[缺失] Python 库 $($item.Dist)"
    } else {
        $warnings++
        Write-Report "[可选] Python 库 $($item.Dist) 未安装（按任务需要再装）"
    }
}

$originalPath = $env:Path
$extraDirs = Get-RegistryPathDirs
foreach ($item in $Tools) {
    $resolved = Find-Tool -Exe $item.Exe -ExtraDirs $extraDirs
    if (-not $resolved) {
        if ($item.Required) {
            $failures++
            $missingTools += $item
            Write-Report "[缺失] $($item.Exe)（$($item.Component)，$($item.Purpose)）"
        } else {
            $warnings++
            Write-Report "[可选] $($item.Exe) 未找到（$($item.Component)，$($item.Purpose)）；含公式的文件验证会返回 partial"
        }
        continue
    }

    Write-Report "[就绪] $($item.Exe) -> $resolved"
    # 注册表 PATH 只在本脚本内用于解析，按调用方的原始 PATH 判断是否需要输出修正。
    $inCallerPath = ($originalPath -split ';' | Where-Object { $_ -and (Test-Path (Join-Path $_ "$($item.Exe).exe")) }).Count -gt 0
    $dir = Split-Path $resolved -Parent
    if (-not $inCallerPath -and $pathFix -notcontains $dir) { $pathFix += $dir }
}

if ($missingPython -or $missingTools) {
    Write-Report ''
    Write-Report '安装指引：'
    if ($missingPython) {
        Write-Report "  Python 库：$PythonBin -m pip install $($missingPython -join ' ')"
    }
    foreach ($item in $missingTools) {
        Write-Report "  $($item.Component)：$($item.Install)"
    }
}

Write-Report ''
if ($failures -gt 0) {
    Write-Report "结果：$failures 个失败，$warnings 个警告；安装以上缺失依赖后重新执行此脚本。"
    exit 1
}

if ($pathFix) {
    $joined = $pathFix -join ';'
    Write-Output "PATH_FIX=$joined"
    Write-Report "以下目录已解析但不在 PATH 中，已输出 PATH 修正值（PATH_FIX）：$joined"
}
Write-Report "结果：0 个失败，$warnings 个警告；环境预检通过。"
exit 0
