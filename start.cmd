@echo off
setlocal
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
echo Learning Map: http://127.0.0.1:8741
echo Keep this window open. Press Ctrl+C to stop.
".venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8741
set "launchExit=%errorlevel%"
popd
if not "%launchExit%"=="0" pause
exit /b %launchExit%
