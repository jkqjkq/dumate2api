@echo off
title dumate2api - stop
echo Stopping dumate2api...
echo.
cd /d "%~dp0"

set PROXY_PORT=9080
set UPSTREAM_PORT=8980
set NOPAUSE=%1

if defined DUMATE2API_PORT set PROXY_PORT=%DUMATE2API_PORT%
if defined DUMATE_UPSTREAM_PORT set UPSTREAM_PORT=%DUMATE_UPSTREAM_PORT%

echo [1/3] Stopping proxy on port %PROXY_PORT% ...
call :killport %PROXY_PORT%

echo [2/3] Stopping DuMate backend on port %UPSTREAM_PORT% ...
call :killport %UPSTREAM_PORT%

echo [3/3] Stopping any leftover dumate-main-server.exe ...
taskkill /F /IM dumate-main-server.exe /T >nul 2>&1
if %errorlevel%==0 (echo       stopped.) else (echo       none running.)

echo.
echo Verifying ports are free...
set STILL=0
for /f "tokens=1" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PROXY_PORT% "') do set STILL=1
if "%STILL%"=="1" (echo   [WARN] port %PROXY_PORT% still in use) else (echo   [OK] port %PROXY_PORT% free)
set STILL2=0
for /f "tokens=1" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%UPSTREAM_PORT% "') do set STILL2=1
if "%STILL2%"=="1" (echo   [WARN] port %UPSTREAM_PORT% still in use) else (echo   [OK] port %UPSTREAM_PORT% free)

echo.
echo Done. DuMate desktop app (if running) was left untouched.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
exit /b 0

:killport
setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%~1 "') do (
    set FOUND=1
    echo       killing PID %%a on port %~1
    taskkill /F /PID %%a /T >nul 2>&1
)
if "!FOUND!"=="0" echo       nothing listening on port %~1
endlocal
exit /b 0