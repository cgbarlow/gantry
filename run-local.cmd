@echo off
REM One-step launcher for gantry: starts `gantry serve` (skipping startup if
REM one's already running) and opens the gantry site in the default browser.
REM
REM Usage: run-local.cmd (double-click it, or run it from any directory)
setlocal EnableDelayedExpansion

REM Resolve the script's own directory so `node bin\gantry.js` can be found
REM regardless of the caller's cwd. %~dp0 always ends with a backslash.
set "SCRIPT_DIR=%~dp0"

REM Matches bin/gantry.js's own `resolvePort` (--port flag > PORT env > 3000).
REM We're not passing --port, so PORT (or its 3000 default) is also what the
REM server itself will end up listening on.
if "%PORT%"=="" set "PORT=3000"
set "URL=http://localhost:%PORT%"

call :probe
if not errorlevel 1 (
  echo gantry is already running at %URL%
  start "" "%URL%"
  goto :eof
)

if not exist "%SCRIPT_DIR%node_modules" (
  echo First-run setup: node_modules not found, running "npm install" ^(this may take a minute^)...
  pushd "%SCRIPT_DIR%"
  call npm install
  if errorlevel 1 (
    echo npm install failed. 1>&2
    popd
    exit /b 1
  )
  popd
)

echo Starting gantry serve on %URL% ...
REM A normal foreground window (not a hidden background process) so a
REM first-time user can see the server's own log output, and so closing the
REM window (or Ctrl+C inside it) stops the server with nothing left orphaned.
start "gantry" cmd /k node "%SCRIPT_DIR%bin\gantry.js" serve

echo Waiting for gantry to start listening on %URL% ...
set /a attempts=0
set /a max_attempts=60

:waitloop
call :probe
if not errorlevel 1 goto ready
set /a attempts+=1
if !attempts! GEQ !max_attempts! (
  echo gantry did not start listening on %URL% within 60 seconds. 1>&2
  echo Check the "gantry" window for errors. 1>&2
  exit /b 1
)
REM ~1s pause. Not `timeout` — it errors out when stdin is redirected
REM (e.g. invoked from another script), which `ping` doesn't.
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
echo gantry is up at %URL%
start "" "%URL%"
echo gantry is running in the "gantry" window. Close that window ^(or press Ctrl+C inside it^) to stop the server.
goto :eof

REM Plain HTTP reachability probe on %URL% — not proof the responder is
REM actually gantry (some other process squatting the port would also pass),
REM which is fine for a local dev convenience script. Sets errorlevel 0 if
REM something answered, non-zero otherwise. Prefers curl (bundled with
REM Windows 10 1803+); falls back to PowerShell's Invoke-WebRequest if curl
REM isn't on PATH.
:probe
where curl >nul 2>nul
if not errorlevel 1 (
  curl -sf -o nul "%URL%" >nul 2>nul
  exit /b %errorlevel%
)
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
exit /b %errorlevel%
