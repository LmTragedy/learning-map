param([int]$Port = 8741)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$projectPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $projectPython)) {
    throw 'Run setup.ps1 first to install local dependencies.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'frontend\dist\index.html'))) {
    throw 'Frontend build is missing. Run setup.ps1 first.'
}
& $projectPython (Join-Path $PSScriptRoot 'scripts\launch.py') --port $Port
exit $LASTEXITCODE
