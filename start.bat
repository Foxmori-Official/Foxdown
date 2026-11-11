@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul || (
  echo Install Node.js 22, then open this file again.
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe call npm ci || exit /b 1
if not exist server\node_modules\express call npm --prefix server ci || exit /b 1
if not exist web\node_modules\vite call npm --prefix web ci || exit /b 1
call npm run build:web || exit /b 1
call npm run dev-electron
