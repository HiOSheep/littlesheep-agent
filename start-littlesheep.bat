@echo off
setlocal
chcp 65001 >nul 2>&1
title LittleSheep
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-littlesheep.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo LittleSheep has exited. Press any key to close.
pause >nul
exit /b %EXIT_CODE%
