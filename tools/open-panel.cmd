@echo off
chcp 936 >nul
title TikTok 广告监控面板

rem 用本文件所在目录推算插件根目录，插件移动后不用改路径
set "ROOT=%~dp0.."
set "SCRIPT=%ROOT%\tools\panel-preview.mjs"
set "PORT=8795"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请先安装 Node.js 并加入 PATH。
  pause
  exit /b 1
)

if not exist "%SCRIPT%" (
  echo [错误] 找不到面板脚本: %SCRIPT%
  pause
  exit /b 1
)

netstat -ano | findstr /C:"127.0.0.1:7890" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
  echo [提示] 本地 7890 代理没有运行，面板会显示缓存数据并提示 ECONNREFUSED。
  echo        请先启动 Clash 之类的代理客户端，再看数据。
  echo.
)

netstat -ano | findstr /C:":%PORT%" | findstr /C:"LISTENING" >nul
if %errorlevel%==0 (
  echo 面板已经在运行，直接打开页面...
  start "" "http://127.0.0.1:%PORT%/"
  timeout /t 2 >nul
  exit /b 0
)

echo 正在启动面板... 稍后会自动打开 http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
node "%SCRIPT%" --port %PORT%
pause