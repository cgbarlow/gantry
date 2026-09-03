@echo off
REM One-step launcher for gantry: starts `gantry serve` (skipping startup if
REM one's already running) and opens the gantry site in the default browser.
REM
REM Usage: run.cmd (double-click it, or run it from any directory).
REM Add /debug for verbose tracing (echoed probe/start commands and their
REM results, curl -v, npm's own verbose log level) when troubleshooting a
REM failure on someone else's machine. /v is accepted as a synonym — same
REM flag names and on/off semantics as install.cmd's /debug, so there's only
REM one convention to learn across both scripts.
REM
REM Every run writes run.log next to this script (overwritten each
REM time, not appended — it always reflects the most recent run), so a
REM failure can be shared without a live screen-share. The log captures this
REM launcher's own probe/startup logic, /debug or not — the flag only
REM changes how much *detail* it gets, never whether logging happens.
REM Deliberately NOT captured: the separate "gantry" server window started
REM below. That window is its own long-running `start`ed console — it was
REM never part of this process's stdout/stderr to begin with, relaunch or
REM not — so the log naturally covers exactly the launcher logic (probe,
REM decide, npm install if needed, hand off to the server window, wait
REM loop) without also having to capture gantry serve's entire lifetime.
setlocal EnableDelayedExpansion

set "DEBUG=0"
if /i "%~1"=="/debug" set "DEBUG=1"
if /i "%~1"=="/v" set "DEBUG=1"

REM Resolve the script's own directory so `node bin\gantry.js` can be found
REM regardless of the caller's cwd. %~dp0 always ends with a backslash.
set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%run.log"

REM Self-relaunch-through-Tee-Object, same trick install.cmd uses: it's the
REM only way to get curl's/npm's/gantry-probe's own console output (not
REM just this script's `echo` lines) into both the console and a file at
REM once, since cmd has no built-in `tee`. `GANTRY_RUN_RELAUNCHED` is
REM inherited by the child process PowerShell spawns (child processes
REM inherit their parent's environment block), so that second pass sees it
REM set and falls through to the real work below instead of relaunching
REM again.
REM
REM The relaunch target and its args are passed through environment
REM variables ($env:GANTRY_SELF / $env:GANTRY_ARGS), not interpolated into
REM the -Command string as escaped text — a path containing a space (a
REM "John Doe"-style username, a OneDrive-redirected Downloads folder — both
REM routine on a real corporate machine) would be exactly the kind of thing
REM hand-built nested quoting gets wrong. PowerShell's `&` call operator
REM invokes a .cmd file directly, and `$env:X` always reads as one literal
REM string regardless of what it contains.
if not "%GANTRY_RUN_RELAUNCHED%"=="1" (
  set "GANTRY_RUN_RELAUNCHED=1"
  set "GANTRY_SELF=%~f0"
  set "GANTRY_ARGS=%*"
  powershell -NoProfile -Command "& $env:GANTRY_SELF $env:GANTRY_ARGS 2>&1 | Tee-Object -FilePath $env:LOG_FILE"
  REM Delayed expansion (`!errorlevel!`, not `%errorlevel%`) is required
  REM here, same reason install.cmd's own relaunch comment gives: inside a
  REM parenthesized block, `%errorlevel%` resolves at parse time (before
  REM the powershell call above even runs), so it would always read
  REM whatever errorlevel was set *before* this block started, never the
  REM actual exit code we're trying to propagate.
  exit /b !errorlevel!
)

REM Plain `echo`, not `>> "%LOG_FILE%"` — this pass's stdout is already the
REM far end of the Tee-Object pipe set up above, which writes it to both
REM the console and the log file itself. A direct `>>` here would bypass
REM that pipe and risk a concurrent-write race against Tee-Object's own
REM in-flight write to the same file.
echo ============================================================
echo Run started %date% %time% (DEBUG=%DEBUG%)
echo ============================================================
if "%DEBUG%"=="1" echo [DEBUG] Verbose mode on — logging to %LOG_FILE%

REM install.cmd (WI #327's no-admin-rights path) unpacks a portable Node
REM build under .node-runtime\node-v<ver>-win-<arch>\ — prefer that over
REM whatever's on PATH if it exists, so a machine that used install.cmd
REM never accidentally falls back to a missing/different global `node`.
REM Matched by wildcard (not a pinned version) so this doesn't need editing
REM every time install.cmd's own pinned version bumps. Any real Node on
REM PATH is untouched either way — this only decides which one *this
REM script* calls.
set "NODE_EXE=node"
set "NPM_CMD=npm"
for /d %%D in ("%SCRIPT_DIR%.node-runtime\node-v*-win-*") do (
  if exist "%%D\node.exe" (
    set "NODE_EXE=%%D\node.exe"
    set "NPM_CMD=%%D\npm.cmd"
  )
)
if "%DEBUG%"=="1" (
  echo [DEBUG] NODE_EXE=%NODE_EXE%
  echo [DEBUG] NPM_CMD=%NPM_CMD%
)

REM Matches bin/gantry.js's own `resolvePort` (--port flag > PORT env > 3000).
REM We're not passing --port, so PORT (or its 3000 default) is also what the
REM server itself will end up listening on.
if "%PORT%"=="" set "PORT=3000"
set "URL=http://localhost:%PORT%"
if "%DEBUG%"=="1" echo [DEBUG] PORT=%PORT% URL=%URL%

call :probe
set "PROBE_RC=!errorlevel!"
if "%DEBUG%"=="1" echo [DEBUG] initial probe of %URL% -^> errorlevel %PROBE_RC%
if %PROBE_RC% EQU 0 (
  echo gantry is already running at %URL%
  start "" "%URL%"
  echo Full trace of this run: %LOG_FILE%
  goto :eof
)

if not exist "%SCRIPT_DIR%node_modules" (
  echo First-run setup: node_modules not found, running "npm install" ^(this may take a minute^)...
  pushd "%SCRIPT_DIR%"
  if "%DEBUG%"=="1" (
    call "%NPM_CMD%" install --loglevel verbose
  ) else (
    call "%NPM_CMD%" install
  )
  if errorlevel 1 (
    echo npm install failed. 1>&2
    echo See %LOG_FILE% for the full trace ^(re-run with /debug for more detail^). 1>&2
    popd
    exit /b 1
  )
  popd
)

echo Starting gantry serve on %URL% ...
if "%DEBUG%"=="1" echo [DEBUG] Command: "%NODE_EXE%" "%SCRIPT_DIR%bin\gantry.js" serve (new window titled "gantry")
REM A normal foreground window (not a hidden background process) so a
REM first-time user can see the server's own log output, and so closing the
REM window (or Ctrl+C inside it) stops the server with nothing left orphaned.
REM This window's own output is intentionally outside run.log — see
REM the header comment above.
start "gantry" cmd /k "%NODE_EXE%" "%SCRIPT_DIR%bin\gantry.js" serve

echo Waiting for gantry to start listening on %URL% ...
set /a attempts=0
set /a max_attempts=60

:waitloop
call :probe
set "PROBE_RC=!errorlevel!"
if "%DEBUG%"=="1" echo [DEBUG] wait-loop probe attempt !attempts! of %URL% -^> errorlevel %PROBE_RC%
if %PROBE_RC% EQU 0 goto ready
set /a attempts+=1
if !attempts! GEQ !max_attempts! (
  echo gantry did not start listening on %URL% within 60 seconds. 1>&2
  echo Check the "gantry" window for errors. 1>&2
  echo See %LOG_FILE% for the full trace ^(re-run with /debug for more detail^). 1>&2
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
echo Full trace of this run: %LOG_FILE%
goto :eof

REM Plain HTTP reachability probe on %URL% — not proof the responder is
REM actually gantry (some other process squatting the port would also pass),
REM which is fine for a local dev convenience script. Sets errorlevel 0 if
REM something answered, non-zero otherwise. Prefers curl (bundled with
REM Windows 10 1803+); falls back to PowerShell's Invoke-WebRequest if curl
REM isn't on PATH. Callers must read the result via `!errorlevel!`
REM (delayed expansion) immediately after `call :probe`, not further down
REM inside a parenthesized block — see the two bugfix comments below for why.
:probe
where curl >nul 2>nul
if not errorlevel 1 (
  REM Bugfix (WI #336): this used to read `%errorlevel%` here, which inside
  REM a parenthesized `( ... )` block is substituted at PARSE time — before
  REM the curl call on the line above has actually run. That meant this
  REM always evaluated to whatever errorlevel the *preceding* `where curl`
  REM check had set (0, since curl was found), so the probe reported
  REM "reachable" unconditionally on any machine with curl on PATH,
  REM regardless of curl's real result. `!errorlevel!` (delayed expansion,
  REM enabled via `setlocal EnableDelayedExpansion` above) is substituted at
  REM RUN time instead, once curl has actually completed — the same fix
  REM already applied to install.cmd for the identical class of bug.
  if "%DEBUG%"=="1" (
    echo [DEBUG] probe: curl -sf -o nul "%URL%"
    curl -v -sf -o nul "%URL%"
  ) else (
    curl -sf -o nul "%URL%" >nul 2>nul
  )
  exit /b !errorlevel!
)
if "%DEBUG%"=="1" (
  echo [DEBUG] probe: curl not found, using PowerShell Invoke-WebRequest
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2 -Verbose | Out-Null; exit 0 } catch { Write-Error $_; exit 1 }"
) else (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
)
REM Not inside a parenthesized block here, so `%errorlevel%` would actually
REM still be correct (parsed and expanded together as one top-level
REM statement, after the powershell call above has run) — using
REM `!errorlevel!` anyway keeps this subroutine consistently on delayed
REM expansion for every errorlevel read, so a future edit that wraps this
REM line in a new `( ... )` block (e.g. adding another debug branch) can't
REM silently reintroduce the same class of bug.
exit /b !errorlevel!
