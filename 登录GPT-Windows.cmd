@echo off
chcp 65001 >nul
pushd "%~dp0"
node scripts\launch.mjs login
pause
popd
