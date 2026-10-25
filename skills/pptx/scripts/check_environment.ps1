<# PPTX 技能环境预检（PowerShell）。不探测网络；本地渲染依赖仅在兜底时检查。 #>

[CmdletBinding()]
param([string]$PythonBin = 'python')

$MinPython = [Version]'3.10'
$PyModules = @(
    @{ Module = 'pptx';       Dist = 'python-pptx' }
    @{ Module = 'lxml.etree'; Dist = 'lxml' }
    @{ Module = 'PIL';        Dist = 'Pillow' }
    @{ Module = 'defusedxml'; Dist = 'defusedxml' }
)

function Write-Report([string]$Message) { [Console]::Error.WriteLine($Message) }

$failures = 0
$warnings = 0
$missingPython = @()
Write-Report "PPTX 环境预检（Windows $env:PROCESSOR_ARCHITECTURE）"

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
    } else {
        $failures++
        $missingPython += $item.Dist
        Write-Report "[缺失] Python 库 $($item.Dist)"
    }
}

$directConvertUrl = 'http://1.48.28.111/xmind/convert-to-image'
if (-not $env:DUMATE_SESSION_ID) {
    $routeUrl = $directConvertUrl
    $routeLabel = '直连服务（未配置 DUMATE_SESSION_ID；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）'
} elseif ($env:DUMATE_SANDBOX_MODE -eq 'server') {
    if ($env:DUMATE_GATEWAY_URL) {
        $routeUrl = $env:DUMATE_GATEWAY_URL.TrimEnd('/') + '/xmind/convert-to-image'
        $routeLabel = 'Dumate Web 网关'
    } else {
        $routeUrl = ''
        $routeLabel = ''
    }
} elseif ($env:DUMATE_SCHEDULER_URL) {
    $routeUrl = $env:DUMATE_SCHEDULER_URL + '/api/qianfanproxy/xmind/convert-to-image'
    $routeLabel = 'Dumate 桌面端 scheduler 代理'
} else {
    $routeUrl = $directConvertUrl
    $routeLabel = '直连服务（桌面端未配置 DUMATE_SCHEDULER_URL；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）'
}

$parsed = $null
if (-not $routeUrl) {
    $failures++
    Write-Report '[错误] Web 端已配置 DUMATE_SESSION_ID，但缺少 DUMATE_GATEWAY_URL'
} elseif ([Uri]::TryCreate($routeUrl, [UriKind]::Absolute, [ref]$parsed) -and
    $parsed.Scheme -in @('http', 'https') -and
    -not $parsed.Fragment) {
    Write-Report "[就绪] 云端转图路由：$routeLabel → $routeUrl"
} else {
    $failures++
    Write-Report "[错误] 云端转图接口不是有效的 http/https 地址：$routeUrl"
}

# 审计修复（P0-2）：直连 fallback 是裸 IP 明文 HTTP，cloud_render.py 默认禁用。
# 这里同步提示路由态势，避免预检报告与实际行为不一致。
if ($routeUrl -eq $directConvertUrl -and $env:DUMATE_ALLOW_REMOTE_CONVERT -ne '1') {
    Write-Report '[警告] 直连云端转图默认禁用（明文 HTTP 外传用户文档）：设 DUMATE_ALLOW_REMOTE_CONVERT=1 可显式开启；云端失败时将走本地渲染兜底'
} elseif ($routeUrl -eq $directConvertUrl) {
    Write-Report "[警告] 直连云端转图已显式启用（DUMATE_ALLOW_REMOTE_CONVERT=1）：文档内容将明文发往 $directConvertUrl"
}

$fallback = if ($env:PPTX_LOCAL_FALLBACK) { $env:PPTX_LOCAL_FALLBACK.ToLower() } else { 'install' }
if ($fallback -in @('off', 'existing', 'install')) {
    Write-Report "[配置] 本地兜底模式 $fallback（仅云端失败时检查依赖）"
} else {
    $failures++
    Write-Report '[错误] PPTX_LOCAL_FALLBACK 只能是 off、existing 或 install'
}

if ($missingPython) {
    Write-Report ''
    Write-Report '安装指引：'
    Write-Report "  Python 库：$PythonBin -m pip install $($missingPython -join ' ')"
}

Write-Report ''
if ($failures -gt 0) {
    Write-Report "结果：$failures 个失败，$warnings 个警告；修复后重新执行此脚本。"
    exit 1
}
Write-Report "结果：0 个失败，$warnings 个警告；环境预检通过。"
exit 0
