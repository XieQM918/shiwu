@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更高版本，然后重新打开此文件。
  echo 下载地址：https://nodejs.org/
  pause
  popd
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 (
  echo 请安装 Node.js 24 或更高版本后重试。
  pause
  popd
  exit /b 1
)
node scripts\launch.mjs start
if errorlevel 1 pause
popd
endlocal
