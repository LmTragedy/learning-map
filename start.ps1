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
Write-Host "Learning Map: http://127.0.0.1:$Port"
Write-Host 'Keep this terminal open. Press Ctrl+C to stop.'
& $projectPython -m uvicorn backend.app:app --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
