@echo off
chcp 65001 >nul
title JM Forum Server
cd /d "%~dp0"

echo ============================================
echo   JM Forum - NodeSeek style community
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Installing dependencies, please wait...
    call npm install --registry=https://registry.npmmirror.com
)

echo [INFO] Starting server at http://localhost:3000
echo [INFO] Press Ctrl+C to stop
echo.
node server.js
pause
