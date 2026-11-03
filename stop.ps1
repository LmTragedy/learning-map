$ErrorActionPreference = 'Stop'
$projectPattern = [regex]::Escape($PSScriptRoot)
$localServers = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
    $_.CommandLine -match $projectPattern -and $_.CommandLine -match '\buvicorn\s+backend\.app:app\b'
}
if (-not $localServers) {
    Write-Host 'No Learning Map server is running from this project.'
    exit 0
}
$localServers | ForEach-Object {
    Get-Process -Id $_.ProcessId -ErrorAction Ignore | Stop-Process -Force -ErrorAction Stop
}
Write-Host 'Learning Map local server stopped. Saved courses remain on disk.'
