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
set NOPAUSE=%1
set DUMATE2API_PORT=9080
rem NOTE: keep comments ASCII-only. cmd.exe parses .bat in the OEM codepage
rem (GBK on zh-CN), NOT the codepage set by chcp above -- so a Chinese comment
rem gets mis-decoded and can emit cmd metacharacters that split the line.
rem Data dir must point at <repo>/data, shared with the dev instance (account
rem pool is shared on purpose). Without it the gateway falls back to
rem stable/data, which holds no credentials -- qwenwork/traework then fail.
set DUMATE_ADMIN_DATA=%~dp0..\data
node src\server.js
echo.
echo 网关已退出。
rem nopause lets scripts start this without the window blocking on a keypress.
if /i "%NOPAUSE%"=="nopause" exit /b 0
pause
