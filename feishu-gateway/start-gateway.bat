@echo off
rem One-click: preflight check first, then start the DSH Feishu gateway.
cd /d "%~dp0"
node src\check.js
if errorlevel 1 goto :notready
node src\index.js
echo.
echo Gateway exited. Press any key to close.
pause >nul
exit /b 0

:notready
echo.
echo ============================================================
echo Configuration is not ready yet (see messages above).
echo First time? Run:  powershell -ExecutionPolicy Bypass -File scripts\setup-guide.ps1
echo ============================================================
pause
exit /b 1
