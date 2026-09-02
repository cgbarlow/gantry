#!/usr/bin/env bash
# One-step launcher for gantry: starts `gantry serve` (skipping startup if one's
# already running) and opens the gantry site in the default browser.
#
# Usage: ./run-local.sh
# Works no matter where it's invoked from (double-clicked, or
# `bash /path/to/run-local.sh` from elsewhere) and no matter the caller's cwd.
set -euo pipefail

# Resolve the script's own directory so `node bin/gantry.js` can be found
# regardless of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Matches bin/gantry.js's own `resolvePort` (--port flag > PORT env > 3000).
# We're not passing --port, so PORT (or its 3000 default) is also what the
# server itself will end up listening on.
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"

open_browser() {
  local url="$1"
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  else
    echo "Could not detect how to open a browser automatically. Open this URL manually: ${url}"
  fi
}

# Plain HTTP reachability probe — not proof the responder is actually gantry
# (some other process squatting the port would also pass), which is fine for
# a local dev convenience script.
is_up() {
  curl -sf -o /dev/null "$URL"
}

if is_up; then
  echo "gantry is already running at ${URL}"
  open_browser "$URL"
  exit 0
fi

if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  echo "First-run setup: node_modules not found, running 'npm install' (this may take a minute)..."
  (cd "$SCRIPT_DIR" && npm install)
fi

echo "Starting gantry serve on ${URL} ..."
node "${SCRIPT_DIR}/bin/gantry.js" serve &
SERVER_PID=$!

# Only kill the server if this script is the one that started it. A server
# found already running (handled above, via the early exit) is left alone.
cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
on_signal() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

echo "Waiting for gantry to start listening on ${URL} ..."
attempts=0
max_attempts=60 # ~30s at 0.5s per attempt
until is_up; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "gantry serve exited unexpectedly before it started listening." >&2
    exit 1
  fi
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$max_attempts" ]; then
    echo "gantry did not start listening on ${URL} within 30 seconds." >&2
    exit 1
  fi
  sleep 0.5
done

echo "gantry is up at ${URL}"
open_browser "$URL"

# This script started the server, so own it: wait on it so Ctrl+C (or closing
# the terminal) stops it cleanly, with no orphaned background node process.
wait "$SERVER_PID"
