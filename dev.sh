#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_VENV="$ROOT_DIR/.venv"

if [[ ! -d "$BACKEND_DIR" || ! -d "$FRONTEND_DIR" ]]; then
  echo "Expected backend/ and frontend/ directories under $ROOT_DIR" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found on PATH." >&2
  exit 1
fi

if [[ ! -x "$BACKEND_VENV/bin/python" ]]; then
  echo "Backend virtualenv not found. Creating one and installing dependencies..."
  python3 -m venv "$BACKEND_VENV"
  "$BACKEND_VENV/bin/pip" install -U pip
  "$BACKEND_VENV/bin/pip" install -e "$BACKEND_DIR"
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "Frontend dependencies not found. Installing with npm..."
  (cd "$FRONTEND_DIR" && npm install)
fi

cleanup() {
  local exit_code=$?
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
  wait >/dev/null 2>&1 || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

echo "Starting backend on http://127.0.0.1:8000 ..."
(
  cd "$BACKEND_DIR"
  source "$BACKEND_VENV/bin/activate"
  python -m probis.main
) &
BACKEND_PID=$!

echo "Starting frontend on http://127.0.0.1:5173 ..."
(
  cd "$FRONTEND_DIR"
  npm run dev -- --host 0.0.0.0
) &
FRONTEND_PID=$!

echo
echo "Probis is launching:"
echo "  Backend : http://127.0.0.1:8000"
echo "  Frontend: http://127.0.0.1:5173"
echo "Press Ctrl-C to stop both."
echo

while true; do
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    wait "$BACKEND_PID" || true
    break
  fi
  if ! kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    wait "$FRONTEND_PID" || true
    break
  fi
  sleep 1
done