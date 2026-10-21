#!/bin/bash
# Double-click to start Fourth & Goal Analytics on a Mac.
# First launch: sets up a private Python environment and downloads the nflverse data (a few minutes).
# Later launches: refreshes this season's data, then opens the app. Close this window to stop the app.
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://127.0.0.1:$PORT"

say_dialog() { osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Fourth & Goal Analytics\"" >/dev/null 2>&1; }

# Already running? Just open it.
if curl -s "$URL/api/health" >/dev/null 2>&1; then open "$URL"; exit 0; fi

PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  say_dialog "Python 3.10 or newer is needed (free). Your browser will open python.org: download the macOS installer, run it, then double-click Start Fourth & Goal again."
  open "https://www.python.org/downloads/macos/"
  exit 1
fi

echo "== Fourth & Goal Analytics =="
if [ ! -x .venv/bin/python ]; then
  echo "First-time setup: creating a private Python environment (about 1 minute)..."
  "$PY" -m venv .venv || { say_dialog "Could not create the Python environment. See the Terminal window for details."; exit 1; }
fi
if [ ! -f .venv/.installed ] || [ backend/requirements.txt -nt .venv/.installed ]; then
  echo "Installing components..."
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r backend/requirements.txt || { say_dialog "Installing components failed. Check your internet connection and try again."; exit 1; }
  touch .venv/.installed
fi

echo "Updating NFL data (first run downloads ~400 MB; later runs only refresh this season)..."
(cd backend && ../.venv/bin/python -m engine.cli all --download) || echo "Data update did not finish. The app will open with the last good data; see the Data & Sync page."

echo "Starting the app at $URL"
(cd backend && ../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port $PORT) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 40); do curl -s "$URL/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
open "$URL"
echo ""
echo "Fourth & Goal is running. Keep this window open while you use it; close it to stop."
wait $SERVER
