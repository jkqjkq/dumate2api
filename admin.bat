@echo off
title dumate2api admin
echo Starting dumate2api admin console...
echo.
cd /d "%~dp0"
echo Open http://127.0.0.1:9081 after it starts.
echo Initial admin password is printed below (only on first run).
echo Forgot it? Run: node src\admin\server.js --reset-admin
echo.
node src\admin\server.js
pause
