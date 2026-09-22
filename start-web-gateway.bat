@echo off
chcp 65001 > nul
title dumate2api - 多账号网关 (9084)
echo ================================================
echo  多账号模型网关 - 端口 9084
echo ================================================
echo.
echo  用「账号管理」里添加的网页凭证跑模型，多账号轮询。
echo  不依赖桌面客户端，与 9080/9082 是两条独立链路。
echo.
echo  先确认账号： http://127.0.0.1:9083 (账号管理)
echo.
cd /d "%~dp0"
set DUMATE_WEB_GATEWAY_PORT=9084
node src\web-gateway.js
pause
