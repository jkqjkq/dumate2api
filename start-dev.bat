@echo off
chcp 65001 > nul
title dumate2api - 开发调试 (9082/9083)
echo ================================================
echo  开发调试实例
echo    网关   9082   (稳定版在 9080，不受影响)
echo    管理端 9083
echo ================================================
echo.
echo  这个脚本用当前主目录的代码（开发中，随时会变）。
echo  稳定版请用 stable\start-stable.bat（端口 9080）。
echo.
cd /d "%~dp0"
echo 正在启动网关（9082）...
start "dumate2api dev gateway 9082" cmd /k "set DUMATE2API_PORT=9082&& node src\server.js"
timeout /t 2 /nobreak > nul
echo 正在启动管理端（9083，观察 9082）...
start "dumate2api dev admin 9083" cmd /k "set DUMATE_ADMIN_PORT=9083&& set DUMATE_ADMIN_GATEWAY_PORT=9082&& node src\admin\server.js"
echo.
echo 两个窗口已打开。
echo   开发管理端： http://127.0.0.1:9083
echo   稳定版管理端：http://127.0.0.1:9081（若在运行）
echo 关闭这两个窗口即可停止开发实例，不影响 9080。
pause
