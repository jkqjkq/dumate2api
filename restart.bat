@echo off
title dumate2api - restart
echo Restarting dumate2api...
echo.
cd /d "%~dp0"

call "%~dp0stop.bat" nopause

echo.
echo Starting proxy in a new window...
start "dumate2api" cmd /k "cd /d "%~dp0" && node src/server.js"

echo.
echo Proxy window opened. It auto-starts the DuMate backend,
echo so allow ~15s before the first request.
echo.
echo Verify with:
echo   curl http://127.0.0.1:9080/health
echo.
exit /b 0