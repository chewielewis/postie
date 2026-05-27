@echo off
setlocal enabledelayedexpansion

echo.
echo  Postie — Windows Setup
echo  ========================
echo.

:: ── Node.js ─────────────────────────────────────────────────────────────────

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Download and install from https://nodejs.org  ^(LTS version^)
    echo         Then re-run this script.
    pause & exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Require v18+
for /f "tokens=1 delims=." %%m in ("%NODE_VER:v=%") do set NODE_MAJOR=%%m
if %NODE_MAJOR% LSS 18 (
    echo [ERROR] Node.js v18 or later required ^(found %NODE_VER%^).
    echo         Download from https://nodejs.org
    pause & exit /b 1
)

:: ── Git ──────────────────────────────────────────────────────────────────────

git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found.
    echo         Download and install from https://git-scm.com/download/win
    echo         Then re-run this script.
    pause & exit /b 1
)

for /f "tokens=*" %%v in ('git --version') do set GIT_VER=%%v
echo [OK] %GIT_VER%

:: ── FFmpeg ───────────────────────────────────────────────────────────────────

ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] FFmpeg not found.
    echo         Download from https://ffmpeg.org/download.html ^(Windows build^)
    echo         Extract and add the bin\ folder to your PATH, then re-run.
    pause & exit /b 1
)

for /f "tokens=3" %%v in ('ffmpeg -version 2^>^&1 ^| findstr /i "ffmpeg version"') do (
    set FFMPEG_VER=%%v
    goto :ffmpeg_ok
)
:ffmpeg_ok
echo [OK] FFmpeg %FFMPEG_VER%

:: ── Repo location ────────────────────────────────────────────────────────────

set SCRIPT_DIR=%~dp0
set REPO_DIR=%SCRIPT_DIR%..

:: Verify we're in the right place
if not exist "%REPO_DIR%\cli\rushes.mjs" (
    echo [ERROR] Cannot locate rushes.mjs. Run this script from inside the postie repo.
    pause & exit /b 1
)

echo [OK] Repo found at %REPO_DIR%

:: ── Git pull ─────────────────────────────────────────────────────────────────

echo.
echo Updating from remote...
cd /d "%REPO_DIR%"
git fetch --quiet
git pull --ff-only --quiet
if errorlevel 1 (
    echo [WARN] Could not pull latest changes. You may be offline or have local modifications.
) else (
    echo [OK] Up to date
)

:: ── .env check ───────────────────────────────────────────────────────────────

if not exist "%REPO_DIR%\cli\.env" (
    echo.
    echo [WARN] cli\.env not found.
    echo        Create cli\.env with:
    echo          SUPABASE_URL=https://...
    echo          SUPABASE_SERVICE_ROLE_KEY=...
    echo        Ask the show admin for these values.
)

:: ── LUT check ────────────────────────────────────────────────────────────────

set LUT_OK=1
if not exist "%REPO_DIR%\cli\luts\slog2_to_709.cube"  set LUT_OK=0
if not exist "%REPO_DIR%\cli\luts\slog3_to_709.cube"  set LUT_OK=0
if not exist "%REPO_DIR%\cli\luts\dlog_m_to_709.cube" set LUT_OK=0

if %LUT_OK%==0 (
    echo.
    echo [WARN] One or more LUT files are missing from cli\luts\
    echo        Copy these files from another machine or the show's shared drive:
    echo          slog2_to_709.cube
    echo          slog3_to_709.cube
    echo          dlog_m_to_709.cube
    echo        LUTs are only needed if you use log preview during ingest.
)

:: ── Done ─────────────────────────────────────────────────────────────────────

echo.
echo  Setup complete.
echo.
echo  To start the ingest tool:
echo    cd cli
echo    node rushes.mjs --show PGHI
echo.
pause
