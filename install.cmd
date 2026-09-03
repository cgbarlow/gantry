@echo off
REM No-admin-rights installer for a locked-down corporate Windows machine
REM (WI #327): downloads the official Node.js *portable ZIP* build (never
REM the installer — that one writes to Program Files and the registry,
REM which needs elevation) straight from nodejs.org, unpacks it under this
REM folder, then runs `npm install` through that unpacked copy. Nothing here
REM touches PATH, the registry, or any system-wide location — a standard
REM (non-admin) Windows account can run every step. If a real global `node`
REM is already on PATH, run-local.cmd still prefers this bundled copy over
REM it once installed, so the two never end up mismatched mid-session.
REM
REM Usage: install.cmd (double-click it, or run it from any directory) once,
REM before the first run-local.cmd.
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"

REM Pin an exact version rather than "latest" — reproducible installs, and
REM this is the version run-local.cmd's own detection (below) is written
REM against. Bump both together. Must satisfy package.json's own
REM `engines.node` floor.
set "NODE_VERSION=24.20.0"

REM Node ships separate portable ZIPs per Windows CPU architecture; a wrong
REM download fails at first run (WinError), not at extract time, which is a
REM confusing place to discover it. `PROCESSOR_ARCHITECTURE` is always set
REM by Windows itself, never user-overridden in practice.
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"

set "NODE_DIST=node-v%NODE_VERSION%-win-%NODE_ARCH%"
set "RUNTIME_DIR=%SCRIPT_DIR%.node-runtime"
set "NODE_HOME=%RUNTIME_DIR%\%NODE_DIST%"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "NPM_CMD=%NODE_HOME%\npm.cmd"

if exist "%NODE_EXE%" (
  echo Portable Node %NODE_VERSION% ^(%NODE_ARCH%^) already present at %NODE_HOME%, skipping download.
  goto npminstall
)

echo Downloading Node.js %NODE_VERSION% ^(%NODE_ARCH%, portable ZIP, no installer^) from nodejs.org...
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
set "ZIP_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_DIST%.zip"
set "ZIP_PATH=%RUNTIME_DIR%\%NODE_DIST%.zip"

REM Same curl-first, PowerShell-fallback pattern as run-local.cmd's own
REM :probe — curl has shipped with Windows 10 since build 1803, so this
REM covers every machine that ships without a real package manager; the
REM PowerShell path covers anything older or with curl removed by policy.
where curl >nul 2>nul
if not errorlevel 1 (
  curl -fSL -o "%ZIP_PATH%" "%ZIP_URL%"
) else (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_PATH%' -UseBasicParsing; exit 0 } catch { Write-Error $_; exit 1 }"
)
if errorlevel 1 (
  echo Download failed: %ZIP_URL% 1>&2
  echo Check network access to nodejs.org, or that %NODE_VERSION%/%NODE_ARCH% is still a published build. 1>&2
  exit /b 1
)

echo Unpacking...
REM `tar` has also shipped with Windows since build 1803 (it's bsdtar,
REM which reads .zip despite the name) — same coverage reasoning as curl
REM above, same PowerShell fallback for anything older.
where tar >nul 2>nul
if not errorlevel 1 (
  tar -xf "%ZIP_PATH%" -C "%RUNTIME_DIR%"
) else (
  powershell -NoProfile -Command "try { Expand-Archive -Path '%ZIP_PATH%' -DestinationPath '%RUNTIME_DIR%' -Force; exit 0 } catch { Write-Error $_; exit 1 }"
)
if errorlevel 1 (
  echo Unpacking failed: %ZIP_PATH% 1>&2
  exit /b 1
)
del "%ZIP_PATH%" >nul 2>nul

if not exist "%NODE_EXE%" (
  echo Expected %NODE_EXE% after unpacking but it's not there — the ZIP's internal layout may have changed upstream. 1>&2
  exit /b 1
)
echo Portable Node %NODE_VERSION% ^(%NODE_ARCH%^) ready at %NODE_HOME%.

:npminstall
echo Running npm install through the bundled npm (this may take a minute)...
pushd "%SCRIPT_DIR%"
call "%NPM_CMD%" install
if errorlevel 1 (
  echo npm install failed. 1>&2
  popd
  exit /b 1
)
popd

echo.
echo Done. Run run-local.cmd to start gantry.
