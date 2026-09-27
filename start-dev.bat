@echo off
chcp 65001 > nul
title dumate2api - dev (9082/9083)
echo ================================================
echo  Dev instance - single window
echo    Gateway 9082  (stable runs on 9080, unaffected)
echo    Admin   9083
echo ================================================
echo.
echo  This script uses the working tree in this repo (changes often).
echo  For the stable snapshot use stable\start-stable.bat (port 9080).
echo.
rem KEEP THIS FILE PURE ASCII -- see the long note in stable\start-stable.bat.
rem cmd.exe parses .bat by byte offset; under chcp 65001 a multi-byte char can
rem desync it and get part of a line executed as a command (non-deterministic).
cd /d "%~dp0"
set NOPAUSE=%1

rem Admin runs in the background of THIS console (`start /b`), so its output
rem interleaves here instead of taking a second window. Both processes share
rem the console, so closing this window stops both.
echo Starting admin (9083, watching 9082) in background...
set DUMATE_ADMIN_PORT=9083
set DUMATE_ADMIN_GATEWAY_PORT=9082
start /b "" node src\admin\server.js
rem Wait for admin to bind 9083 so its startup line lands before the gateway's.
rem Use ping, not `timeout`: under a POSIX shell (Git Bash / MSYS) `timeout` is
rem shadowed by the GNU coreutils one, which rejects `/t` and exits non-zero.
ping -n 3 127.0.0.1 > nul 2>&1

echo Starting gateway (9082) in foreground...
echo.
echo   Dev admin:    http://127.0.0.1:9083
echo   Stable admin: http://127.0.0.1:9081 (if running)
echo   Port 9080 is not touched.
echo.
echo   Ctrl+C or close this window to stop both.
echo ================================================
echo.

set DUMATE2API_PORT=9082
node src\server.js

echo.
echo Gateway exited. Stopping admin...
rem Kill the admin by the port it listens on. Closing the window would also
rem take it down, but reaching here (Ctrl+C / gateway crash) would otherwise
rem leave it orphaned on 9083.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9083 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo Done.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
