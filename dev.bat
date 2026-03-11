@echo off
setlocal

echo ===================================================
echo   KORAT HEALTH KPI - DEVELOPMENT MODE
echo ===================================================
echo.

REM --- [0] Close old dev terminal windows by title (must match exactly) ---
echo [0/2] Closing previous dev servers...

REM /T kills the entire process tree (nodemon + node child processes)
taskkill /FI "WINDOWTITLE eq KHUPS-KPI-API-DEV" /F /T >nul 2>&1
taskkill /FI "WINDOWTITLE eq KHUPS-KPI-WEB-DEV" /F /T >nul 2>&1

REM Give process tree time to terminate
ping -n 2 127.0.0.1 >nul

REM Kill any remaining processes on port 3000 (API nodemon)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do (
    echo      -^> Stopping process on port 3000 ^(PID: %%a^)
    taskkill /F /T /PID %%a >nul 2>&1
)

REM Kill any remaining processes on port 4200 (Frontend ng serve)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4200 " ^| findstr "LISTENING" 2^>nul') do (
    echo      -^> Stopping process on port 4200 ^(PID: %%a^)
    taskkill /F /T /PID %%a >nul 2>&1
)

echo      -^> Cleanup complete. Waiting for ports to free...
ping -n 3 127.0.0.1 >nul

REM --- [1] Start API with nodemon on port 3000 ---
echo [1/2] Starting API with nodemon on port 3000...
start "KHUPS-KPI-API-DEV" cmd /k "cd /d %~dp0api && set NODE_ENV=development && npm run dev"

REM Small delay before opening second window
ping -n 2 127.0.0.1 >nul

REM --- [2] Start Frontend with ng serve at /khupskpi/ on port 4200 ---
echo [2/2] Starting Frontend with ng serve on port 4200...
start "KHUPS-KPI-WEB-DEV" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo ===================================================
echo   Frontend : http://localhost:4200/khupskpi/    ^(ng serve^)
echo   API      : http://localhost:3000/khupskpi/api ^(nodemon^)
echo   Docker   : http://localhost:8881/khupskpi/    ^(unchanged^)
echo.
echo   Press Ctrl+C in each window to stop.
echo ===================================================
echo.

endlocal
