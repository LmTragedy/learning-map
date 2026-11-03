$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$projectPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& python -c "import sys; sys.exit(0 if sys.version_info >= (3, 13) else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Python 3.13 or newer is required (see pyproject.toml requires-python).' }
if (-not (Test-Path -LiteralPath $projectPython)) {
    & python -m venv --without-pip .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
}
& python -m pip --python $projectPython install -r requirements.lock
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
Push-Location frontend
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Push-Location scripts
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Local OCR dependency installation failed.' }
} finally { Pop-Location }
Write-Host 'Setup complete. Run .\start.ps1 and open http://127.0.0.1:8741'
