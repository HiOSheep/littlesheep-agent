@echo off
setlocal
chcp 65001 >nul 2>&1
title Build LittleSheep
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-app.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Build failed. Check the output above.
if "%EXIT_CODE%"=="0" echo Done. Double-click LittleSheep on your desktop to launch.
pause >nul
exit /b %EXIT_CODE%
