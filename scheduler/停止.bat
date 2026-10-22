@echo off
chcp 65001 >nul
call "%~dp0..\scripts\stop_service_by_port.bat" "Scheduler服务" "18091"
exit /b %errorlevel%
