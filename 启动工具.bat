@echo off
setlocal
cd /d "%~dp0"
title AI Video Story Tool

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-tool.ps1"

if errorlevel 1 (
  echo.
  echo Startup failed. Review the message above, then press any key to close.
  pause >nul
)

endlocal
