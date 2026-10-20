@echo off
setlocal
cd /d "%~dp0"
rem Set console size first: pwsh 7.6 crashes with "totalWidth must be a
rem non-negative value" when the console measures 0 columns.
mode con: cols=140 lines=45
title npm publish dsh-vault
cls
echo.
echo  ============================================================
echo    dsh-vault - manual npm publish
echo  ============================================================
echo.
echo    A real console window is required: npm only prompts
echo    "Enter OTP:" when stdin is a TTY. Background processes
echo    get no TTY and fall back to the legacy Username: prompt,
echo    which exits immediately.
echo.
pwsh -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0publish-manual.ps1"
