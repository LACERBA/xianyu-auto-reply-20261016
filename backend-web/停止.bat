@echo off
chcp 65001 >nul
call "%~dp0..\scripts\stop_service_by_port.bat" "Backend-Web服务" "18089"
exit /b %errorlevel%
