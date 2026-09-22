@echo off
chcp 65001 > nul
title dumate2api - 稳定版 (9080)
echo ================================================
echo  稳定版网关 - 端口 9080
echo  供 cc-switch / Codex / Claude Code 使用
echo ================================================
echo.
echo  这份代码是快照，不会随开发改动。见 SNAPSHOT_FROM.txt
echo  开发调试请用 start-dev.bat（端口 9082）
echo.
cd /d "%~dp0"
set DUMATE2API_PORT=9080
set DUMATE_ADMIN_DATA=%~dp0..\data
node src\server.js
pause
