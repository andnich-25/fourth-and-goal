@echo off
rem Double-click to start Fourth & Goal Analytics on Windows. Close this window to stop the app.
cd /d "%~dp0"
set PORT=8765
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is needed. Opening python.org - install it ^(tick "Add python.exe to PATH"^), then run this again.
  start https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo First-time setup: creating a private Python environment...
  %PY% -m venv .venv
)
if not exist .venv\.installed (
  echo Installing components...
  .venv\Scripts\python -m pip install --quiet --upgrade pip
  .venv\Scripts\python -m pip install --quiet -r backend\requirements.txt && type nul > .venv\.installed
)
echo Updating NFL data ^(first run downloads ~400 MB^)...
pushd backend
..\.venv\Scripts\python -m engine.cli all --download
start "" /min cmd /c "timeout /t 5 >nul & start http://127.0.0.1:%PORT%"
echo Fourth ^& Goal is running. Keep this window open; close it to stop.
..\.venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port %PORT%
popd
