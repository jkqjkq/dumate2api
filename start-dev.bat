@echo off
chcp 65001 > nul
title dumate2api - dev (9082/9083)
echo ================================================
echo  Dev instance
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
echo Starting gateway (9082)...
start "dumate2api dev gateway 9082" cmd /k "set DUMATE2API_PORT=9082&& node src\server.js"
timeout /t 2 /nobreak > nul
echo Starting admin (9083, watching 9082)...
start "dumate2api dev admin 9083" cmd /k "set DUMATE_ADMIN_PORT=9083&& set DUMATE_ADMIN_GATEWAY_PORT=9082&& node src\admin\server.js"
echo.
echo Both windows opened.
echo   Dev admin:    http://127.0.0.1:9083
echo   Stable admin: http://127.0.0.1:9081 (if running)
echo Close those two windows to stop the dev instance. Port 9080 is not touched.
pause
