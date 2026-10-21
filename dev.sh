#!/usr/bin/env bash
# One-command local dev: API on :8000, Vite on :5173 (proxying /api).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
(cd "$ROOT/backend" && uvicorn main:app --reload --port 8000) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd "$ROOT/frontend" && npm run dev
