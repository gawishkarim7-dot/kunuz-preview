@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.12 or newer, then try again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm, then try again.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

set "PORT=3026"
echo Starting Kunooz Al-Huqul at http://127.0.0.1:3026
start "" "http://127.0.0.1:3026"
call npm start

if errorlevel 1 echo The server stopped with an error.
pause
