@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\.bin\vinext.cmd" (
  echo 找不到本機相依套件，請通知 Codex 完成安裝。
  pause
  exit /b 1
)
if not exist "dist\server\index.js" (
  echo 正在建立本機情報系統...
  call npm run build
  if errorlevel 1 (
    echo 建置失敗，請通知 Codex 檢查。
    pause
    exit /b 1
  )
)
node preview-server.mjs --open
pause
