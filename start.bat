@echo off
cd /d "%~dp0"
echo ========================================
echo   Bilibili Video Downloader
echo ========================================
echo.
echo Cleaning up old processes...
taskkill /f /im python.exe >nul 2>&1
timeout /t 1 /nobreak >nul
echo Starting server at http://127.0.0.1:5000
echo.
python main.py
echo.
pause
