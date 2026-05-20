@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage.ps1" restart
echo.
pause
