@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo      KORAT HEALTH KPI - BUILD ^& DEPLOY SCRIPT
echo ===================================================
echo.

echo [1/5] Cleaning up old distribution artifacts...
echo      -^> Targeting 'frontend\dist'...
del /f /q frontend\dist 2>nul
rd /s /q frontend\dist 2>nul
echo      -^> Targeting 'api\dist'...
del /f /q api\dist 2>nul
rd /s /q api\dist 2>nul
echo      -^> Cleanup complete.
echo.

set FRONTEND_OK=0
set API_OK=0

REM -------------------------------------------------------
REM [2/5] Build Frontend (Angular)
REM -------------------------------------------------------
echo [2/5] Building Frontend Application (Angular)...
cd frontend
call npm run build -- --base-href /khupskpi/
if %errorlevel% neq 0 (
    echo.
    echo !-- FRONTEND BUILD FAILED --!
    cd ..
    goto :summary
)
cd ..

REM Flatten Angular output: dist\kpi-web\browser\ -> dist\
echo      -^> Flattening Angular output to frontend\dist\...
if exist "frontend\dist\kpi-web\browser" (
    xcopy "frontend\dist\kpi-web\browser\*" "frontend\dist\" /E /I /Y /Q >nul 2>&1
    rd /s /q "frontend\dist\kpi-web" 2>nul
)

set FRONTEND_OK=1
echo      -^> Frontend build successful.
echo.

REM -------------------------------------------------------
REM [3/5] Build API (copy source -> dist, install deps)
REM -------------------------------------------------------
echo [3/5] Building API Application (Node.js)...
cd api
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo !-- API BUILD FAILED --!
    cd ..
    goto :summary
)
echo      -^> Installing production dependencies...
call npm install --production
if %errorlevel% neq 0 (
    echo.
    echo !-- API DEPENDENCY INSTALL FAILED --!
    cd ..
    goto :summary
)
set API_OK=1
cd ..
echo      -^> API build successful.
echo.

:summary
echo.
echo ===================================================
echo      BUILD STATUS SUMMARY
echo ===================================================
echo.

REM --- Frontend Status ---
if %FRONTEND_OK%==1 (
    echo   [OK] Frontend ^(Angular^)
    if exist "frontend\dist\index.html" (
        echo        -^> Output : frontend\dist\
        for /f %%A in ('dir /s /b "frontend\dist" 2^>nul ^| find /c /v ""') do echo        -^> Files  : %%A files
    )
) else (
    echo   [FAIL] Frontend ^(Angular^) - Build failed!
)
echo.

REM --- API Status ---
if %API_OK%==1 (
    echo   [OK] API ^(Node.js^)
    if exist "api\dist\server.js" (
        echo        -^> Output : api\dist\server.js
    )
) else (
    echo   [FAIL] API ^(Node.js^) - Build failed!
)
echo.

REM --- Config Status ---
echo   --- Configuration ---
if exist ".env" (
    echo   [OK] .env file found
) else (
    echo   [!!] .env file NOT FOUND - copy from .env.example
)
echo.

REM --- If build failed, stop here ---
if %FRONTEND_OK%==0 goto :buildfailed
if %API_OK%==0 goto :buildfailed

REM -------------------------------------------------------
REM [4/5] Deploy to Docker
REM -------------------------------------------------------
echo ===================================================
echo [4/5] Deploying to Docker (background mode)...
echo ===================================================
echo.

docker compose down 2>nul
docker compose up -d --build
if %errorlevel% neq 0 (
    echo.
    echo   [FAIL] Docker deploy failed!
    goto :buildfailed
)
echo.

REM -------------------------------------------------------
REM [5/5] Final Status
REM -------------------------------------------------------
echo ===================================================
echo [5/5] Verifying containers...
echo ===================================================
echo.
docker compose ps
echo.
echo ===================================================
echo   [DONE] Deploy successful!
echo   Frontend : http://localhost:8881/khupskpi/
echo   API      : http://localhost:8830/khupskpi/api
echo ===================================================
echo.

endlocal
goto :eof

:buildfailed
echo ===================================================
echo   [NOT READY] Fix the errors above before deploying.
echo ===================================================
echo.
endlocal
exit /b 1
