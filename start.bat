@echo off
title dumate2api
echo Starting dumate2api proxy...
echo.
cd /d "%~dp0"
if not exist node_modules (
    echo No dependencies needed - pure Node.js
)
node src/server.js
pause
