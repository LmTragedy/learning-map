@echo off
setlocal
chcp 65001 >nul
title Learning Map - server log
pushd "%~dp0" || exit /b 1
if not exist ".venv\Scripts\python.exe" (
    echo Python environment is missing. Install the project dependencies first.
    popd
    pause
    exit /b 1
)
if not exist "frontend\dist\index.html" (
    echo Frontend build is missing. Build the frontend first.
    popd
    pause
    exit /b 1
)
".venv\Scripts\python.exe" scripts\launch.py %*
set "launchExit=%errorlevel%"
popd
echo.
echo Server stopped. You can close this window.
pause
exit /b %launchExit%
