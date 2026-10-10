@echo off
rem WorkBuddy Account Hub launcher (ASCII only)
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [wb-desktop] Electron not found. Run in this folder: pnpm install ^&^& pnpm build
  pause
  exit /b 1
)
start "" "%ELECTRON%" "%~dp0dist\main.cjs"
