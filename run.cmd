@echo off
REM One-step launcher for gantry: starts `gantry serve` (skipping startup if
REM one's already running) and opens the gantry site in the default browser.
REM
REM Usage: run.cmd (double-click it, or run it from any directory).
REM Add /debug for verbose tracing (echoed probe commands and their results,
REM curl -v, npm's own verbose log level) when troubleshooting a failure on
REM someone else's machine. /v is accepted as a synonym — same flag names
REM and on/off semantics as install.cmd's /debug, so there's only one
REM convention to learn across both scripts.
REM
REM gantry serve runs directly in THIS window — the window you ran this
REM script from becomes the server's console for as long as it's running.
REM Close the window, or press Ctrl+C inside it, to stop the server. An
REM earlier version opened a second "gantry" window instead; that hit two
REM separate real-world Windows quirks in a row (a cmd /k quoting bug,
REM WI #337; a handle-inheritance hang, WI #338), both eliminated by not
REM spawning a second console at all (WI #339).
REM
REM Every run writes run.log next to this script (overwritten each time,
REM not appended), capturing this launcher's own setup logic AND gantry
REM serve's own output for the whole session, since it's all one process
REM now — so a failure (or the server's own runtime log) can be shared
REM without a live screen-share.
setlocal EnableDelayedExpansion

set "DEBUG=0"
if /i "%~1"=="/debug" set "DEBUG=1"
if /i "%~1"=="/v" set "DEBUG=1"

REM Resolve the script's own directory so `node bin\gantry.js` can be found
REM regardless of the caller's cwd. %~dp0 always ends with a backslash.
set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%run.log"

REM Self-relaunch-through-Tee-Object, same trick install.cmd uses: it's the
REM only way to get curl's/npm's/gantry's own console output (not just this
REM script's `echo` lines) into both the console and a file at once, since
REM cmd has no built-in `tee`. `GANTRY_RUN_RELAUNCHED` is inherited by the
REM child process PowerShell spawns (child processes inherit their parent's
REM environment block), so that second pass sees it set and falls through
REM to the real work below instead of relaunching again.
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
if "%DEBUG%"=="1" echo [DEBUG] Command: "%NODE_EXE%" "%SCRIPT_DIR%bin\gantry.js" serve

REM Open the browser after a short fixed delay rather than a confirmed-ready
REM probe loop: gantry serve (below) is about to become this window's own
REM foreground process, blocking until Ctrl+C, so there's no script left
REM running afterward to wait-loop from. This background one-liner is
REM bounded and only opens a browser tab — a much smaller surface than the
REM probe-loop-in-a-second-window design that caused WI #337/#338. If the
REM page loads before the server's finished starting up, a manual refresh a
REM moment later is all that's needed. Powershell (not a nested `cmd /c`)
REM specifically to steer clear of cmd's /C multi-quote parsing pitfall
REM (WI #337) for this one-liner too.
start /B "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

echo Full trace of this run (including gantry's own output): %LOG_FILE%
"%NODE_EXE%" "%SCRIPT_DIR%bin\gantry.js" serve
goto :eof

REM Plain HTTP reachability probe on %URL% — not proof the responder is
REM actually gantry (some other process squatting the port would also pass),
REM which is fine for a local dev convenience script. Sets errorlevel 0 if
REM something answered, non-zero otherwise. Prefers curl (bundled with
REM Windows 10 1803+); falls back to PowerShell's Invoke-WebRequest if curl
REM isn't on PATH. Callers must read the result via `!errorlevel!`
REM (delayed expansion) immediately after `call :probe`, not further down
REM inside a parenthesized block — see the bugfix comment below for why.
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
