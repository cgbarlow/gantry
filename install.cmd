@echo off
REM No-admin-rights installer for a locked-down corporate Windows machine
REM (WI #327): downloads the official Node.js *portable ZIP* build (never
REM the installer — that one writes to Program Files and the registry,
REM which needs elevation) straight from nodejs.org, unpacks it under this
REM folder, then runs `npm install` through that unpacked copy. Nothing here
REM touches PATH, the registry, or any system-wide location — a standard
REM (non-admin) Windows account can run every step. If a real global `node`
REM is already on PATH, run.cmd still prefers this bundled copy over
REM it once installed, so the two never end up mismatched mid-session.
REM
REM Usage: install.cmd (double-click it, or run it from any directory) once,
REM before the first run.cmd. Add /debug for verbose tracing
REM (echoed commands, curl -v, npm's own verbose log level) when
REM troubleshooting a failure on someone else's machine.
REM
REM Every run writes install.log next to this script (overwritten each
REM time, not appended — it always reflects the most recent run), so a
REM failure on a locked-down machine can be emailed/screenshotted to
REM whoever's helping without needing a live screen-share. The log
REM captures everything the console shows, /debug or not — the flag only
REM changes how much *detail* both of them get, never whether logging
REM happens at all.
setlocal EnableDelayedExpansion

set "DEBUG=0"
if /i "%~1"=="/debug" set "DEBUG=1"
if /i "%~1"=="/v" set "DEBUG=1"

set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%install.log"

REM Self-relaunch-through-Tee-Object: the only way to get curl's and npm's
REM *own* console output (not just this script's `echo` lines) into both
REM the console and a file at once, since cmd has no built-in `tee`.
REM `GANTRY_INSTALL_RELAUNCHED` is inherited by the child process
REM PowerShell spawns (child processes inherit their parent's environment
REM block), so that second pass sees it set and falls through to the real
REM work below instead of relaunching again.
REM
REM The relaunch target and its args are passed through environment
REM variables ($env:GANTRY_SELF / $env:GANTRY_ARGS), not interpolated
REM into the -Command string as escaped text — a path containing a space
REM (a "John Doe"-style username, a OneDrive-redirected Downloads folder —
REM both routine on a real corporate machine) would be exactly the kind
REM of thing hand-built nested quoting gets wrong. PowerShell's `&` call
REM operator invokes a .cmd file directly (no explicit `cmd /c` needed —
REM the .cmd/.bat association handles that itself), and `$env:X` always
REM reads as one literal string regardless of what it contains.
if not "%GANTRY_INSTALL_RELAUNCHED%"=="1" (
  set "GANTRY_INSTALL_RELAUNCHED=1"
  set "GANTRY_SELF=%~f0"
  set "GANTRY_ARGS=%*"
  powershell -NoProfile -Command "& $env:GANTRY_SELF $env:GANTRY_ARGS 2>&1 | Tee-Object -FilePath $env:LOG_FILE"
  REM Delayed expansion (`!errorlevel!`, not `%errorlevel%`) is required
  REM here — inside a parenthesized block, `%errorlevel%` resolves at
  REM parse time (before the powershell call above even runs), so it
  REM would always read whatever errorlevel was set *before* this block
  REM started, never the actual exit code we're trying to propagate.
  exit /b !errorlevel!
)

REM Plain `echo`, not `>> "%LOG_FILE%"` — this pass's stdout is already
REM the far end of the Tee-Object pipe set up above, which writes it to
REM both the console and the log file itself. A direct `>>` here would
REM bypass that pipe (so these lines would silently never reach the
REM console) and risks a concurrent-write race against Tee-Object's own
REM in-flight write to the same file.
echo ============================================================
echo Run started %date% %time% (DEBUG=%DEBUG%)
echo ============================================================
if "%DEBUG%"=="1" echo [DEBUG] Verbose mode on — logging to %LOG_FILE%

REM Pin an exact version rather than "latest" — reproducible installs, and
REM this is the version run.cmd's own detection (below) is written
REM against. Bump both together. Must satisfy package.json's own
REM `engines.node` floor.
set "NODE_VERSION=24.20.0"

REM Node ships separate portable ZIPs per Windows CPU architecture; a wrong
REM download fails at first run (WinError), not at extract time, which is a
REM confusing place to discover it. `PROCESSOR_ARCHITECTURE` is always set
REM by Windows itself, never user-overridden in practice.
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
if "%DEBUG%"=="1" echo [DEBUG] PROCESSOR_ARCHITECTURE=%PROCESSOR_ARCHITECTURE% -^> NODE_ARCH=%NODE_ARCH%

set "NODE_DIST=node-v%NODE_VERSION%-win-%NODE_ARCH%"
set "RUNTIME_DIR=%SCRIPT_DIR%.node-runtime"
set "NODE_HOME=%RUNTIME_DIR%\%NODE_DIST%"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "NPM_CMD=%NODE_HOME%\npm.cmd"
if "%DEBUG%"=="1" (
  echo [DEBUG] NODE_HOME=%NODE_HOME%
  echo [DEBUG] NODE_EXE=%NODE_EXE%
  echo [DEBUG] NPM_CMD=%NPM_CMD%
)

if exist "%NODE_EXE%" (
  echo Portable Node %NODE_VERSION% ^(%NODE_ARCH%^) already present at %NODE_HOME%, skipping download.
  goto npminstall
)

echo Downloading Node.js %NODE_VERSION% ^(%NODE_ARCH%, portable ZIP, no installer^) from nodejs.org...
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
set "ZIP_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_DIST%.zip"
set "ZIP_PATH=%RUNTIME_DIR%\%NODE_DIST%.zip"
if "%DEBUG%"=="1" echo [DEBUG] ZIP_URL=%ZIP_URL%

REM Same curl-first, PowerShell-fallback pattern as run.cmd's own
REM :probe — curl has shipped with Windows 10 since build 1803, so this
REM covers every machine that ships without a real package manager; the
REM PowerShell path covers anything older or with curl removed by policy.
REM `-v` (curl) / `-Verbose` (Invoke-WebRequest) only in debug mode — full
REM request/response header tracing is noise on a normal run.
REM `-sS` ("silent but show errors"): curl always writes its own progress
REM meter to stderr, even on a clean run. The self-relaunch above merges
REM stderr into stdout (2>&1) before piping through PowerShell for logging,
REM and PowerShell renders any merged native-command stderr text as a
REM NativeCommandError block — so a fully successful download displayed as
REM what looked like a fatal error. `-s` drops the progress meter entirely;
REM `-S` (kept from before) still forces a real error message through even
REM with `-s` set, so a genuine failure (bad URL, network down, etc.) below
REM still reports clearly and still trips `errorlevel 1`. `-v` in debug mode
REM is untouched — its request/response trace is what /debug is for.
where curl >nul 2>nul
if not errorlevel 1 (
  if "%DEBUG%"=="1" (
    curl -v -sS -fL -o "%ZIP_PATH%" "%ZIP_URL%"
  ) else (
    curl -sS -fL -o "%ZIP_PATH%" "%ZIP_URL%"
  )
) else (
  REM PowerShell equivalent of curl's `-s`: Invoke-WebRequest's default
  REM progress-bar rendering is the analogous noisy-on-success behavior;
  REM `$ProgressPreference='SilentlyContinue'` (scoped to this one-liner via
  REM the try block, not a persistent setting) suppresses it while leaving
  REM the catch block's `Write-Error` — and the real download itself — fully
  REM intact for genuine failures.
  if "%DEBUG%"=="1" (
    powershell -NoProfile -Command "try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_PATH%' -UseBasicParsing -Verbose; exit 0 } catch { Write-Error $_; exit 1 }"
  ) else (
    powershell -NoProfile -Command "try { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_PATH%' -UseBasicParsing; exit 0 } catch { Write-Error $_; exit 1 }"
  )
)
if errorlevel 1 (
  echo Download failed: %ZIP_URL% 1>&2
  echo Check network access to nodejs.org, or that %NODE_VERSION%/%NODE_ARCH% is still a published build. 1>&2
  echo See %LOG_FILE% for the full trace ^(re-run with /debug for more detail^). 1>&2
  exit /b 1
)

echo Unpacking...
REM `tar` has also shipped with Windows since build 1803 (it's bsdtar,
REM which reads .zip despite the name) — same coverage reasoning as curl
REM above, same PowerShell fallback for anything older. `-v` lists each
REM extracted file in debug mode.
where tar >nul 2>nul
if not errorlevel 1 (
  if "%DEBUG%"=="1" (
    tar -xvf "%ZIP_PATH%" -C "%RUNTIME_DIR%"
  ) else (
    tar -xf "%ZIP_PATH%" -C "%RUNTIME_DIR%"
  )
) else (
  if "%DEBUG%"=="1" (
    powershell -NoProfile -Command "try { Expand-Archive -Path '%ZIP_PATH%' -DestinationPath '%RUNTIME_DIR%' -Force -Verbose; exit 0 } catch { Write-Error $_; exit 1 }"
  ) else (
    powershell -NoProfile -Command "try { Expand-Archive -Path '%ZIP_PATH%' -DestinationPath '%RUNTIME_DIR%' -Force; exit 0 } catch { Write-Error $_; exit 1 }"
  )
)
if errorlevel 1 (
  echo Unpacking failed: %ZIP_PATH% 1>&2
  echo See %LOG_FILE% for the full trace ^(re-run with /debug for more detail^). 1>&2
  exit /b 1
)
del "%ZIP_PATH%" >nul 2>nul

if not exist "%NODE_EXE%" (
  echo Expected %NODE_EXE% after unpacking but it's not there — the ZIP's internal layout may have changed upstream. 1>&2
  exit /b 1
)
echo Portable Node %NODE_VERSION% ^(%NODE_ARCH%^) ready at %NODE_HOME%.

:npminstall
REM `--omit=dev`: this installer is for *running* gantry, not for
REM developing/testing it, so devDependencies are skipped entirely.
REM Without this, a full `npm install` also installs devDependency
REM node-test-junit-reporter, which pulls in node-test-parser as a *git*
REM dependency (github:nearform/node-test-parser#v2.2.1, per
REM package-lock.json) — npm always re-runs a git dependency's own
REM lifecycle scripts fresh at install time, and that repo's package.json
REM has "prepare": "husky install", which shells out to a bare `node` that
REM doesn't exist on PATH here by design (see the top-of-file note on never
REM touching PATH). That made the whole install abort fatally even though
REM nothing needed to actually *run* gantry depends on it. See WI #335.
echo Running npm install through the bundled npm (production dependencies only, this may take a minute)...
pushd "%SCRIPT_DIR%"
if "%DEBUG%"=="1" (
  call "%NPM_CMD%" install --omit=dev --loglevel verbose
) else (
  call "%NPM_CMD%" install --omit=dev
)
if errorlevel 1 (
  echo npm install failed. 1>&2
  echo See %LOG_FILE% for the full trace ^(re-run with /debug for more detail^). 1>&2
  popd
  exit /b 1
)
popd

echo.
echo Done. Run run.cmd to start gantry.
echo Full trace of this run: %LOG_FILE%
