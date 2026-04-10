@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   KORAT HEALTH KPI - DEVELOPMENT MODE
echo ===================================================
echo.

REM --- Kill existing dev processes first ---
echo [0/2] Closing previous dev servers...

REM Kill process on port 3700 (API nodemon)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3700 " ^| findstr "LISTENING"') do (
    echo      -^> Stopping API on port 3700 ^(PID: %%a^)
    taskkill /F /PID %%a >nul 2>&1
)

REM Kill process on port 4500 (Frontend ng serve)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4500 " ^| findstr "LISTENING"') do (
    echo      -^> Stopping Frontend on port 4500 ^(PID: %%a^)
    taskkill /F /PID %%a >nul 2>&1
)

REM Close old dev terminal windows by title
taskkill /FI "WINDOWTITLE eq KHUPS-KPI-API [DEV :3700]*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq KHUPS-KPI-WEB [DEV :4500]*" /F >nul 2>&1

echo      -^> Cleanup complete.
echo.

REM --- Start API with nodemon on port 3700 (new window) ---
echo [1/2] Starting API with nodemon on port 3700...
echo      -^> Using config from api\.env.dev
start "KHUPS-KPI-API [DEV :3700]" cmd /k "cd /d %~dp0api && set NODE_ENV=development && npm run dev"

REM --- Start Frontend with ng serve on port 4500 (new window) ---
echo [2/2] Starting Frontend with ng serve on port 4500...
start "KHUPS-KPI-WEB [DEV :4500]" cmd /k "cd /d %~dp0frontend && npm run dev"

REM Read DB_HOST from .env.dev for display
set "SHOW_DBHOST="
for /f "tokens=1,* delims==" %%a in ('type "%~dp0api\.env.dev" ^| findstr "^DB_HOST="') do (
    set "SHOW_DBHOST=%%b"
)

echo.
echo ===================================================
echo   Frontend : http://localhost:4500/khupskpi/    ^(ng serve^)
echo   API      : http://localhost:3700/khupskpi/api ^(nodemon^)
if not "!SHOW_DBHOST!"=="" (
echo   DB_HOST  : !SHOW_DBHOST! ^(from api\.env.dev^)
)
echo.
echo   Docker   : http://localhost:8881/khupskpi/    ^(use build.bat^)
echo.
echo   Press Ctrl+C in each window to stop.
echo ===================================================
echo.

endlocal
