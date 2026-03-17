@echo off
chcp 65001 >nul
echo Останавливаем все процессы Node.js...
taskkill /F /IM node.exe 2>nul
if %errorlevel% equ 0 (echo Процессы остановлены.) else (echo Процессов Node не найдено.)
timeout /t 2 /nobreak >nul
echo.
echo Запуск приложения СУРВ...
cd /d "%~dp0"
start "SURV" cmd /k "npm start"
echo.
echo Окно с сервером открыто. Закройте его перед повторным запуском restart.bat.
pause
