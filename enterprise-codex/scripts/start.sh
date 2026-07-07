#!/usr/bin/env bash
# Start the gateway (reads .env via gateway/config.js). macOS + Linux friendly.
#   ./scripts/start.sh                        # use UPSTREAM_* from .env (your real key)
#   ./scripts/start.sh --with-mock-upstream   # trial: no real API calls, canned responses
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env found. Run: scripts/setup.sh"; exit 1; }

if [ "${1:-}" = "--with-mock-upstream" ]; then
  echo "== trial mode: starting bundled mock upstream (no real API calls) =="
  export UPSTREAM_BASE_URL="http://127.0.0.1:8091/v1"
  export UPSTREAM_API_KEY="mock-upstream-key"
  node mock-upstream/server.js & MOCK_PID=$!
  trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
  for i in $(seq 1 20); do curl -sf http://127.0.0.1:8091/ >/dev/null 2>&1 && break; sleep 0.2; done
fi

echo "== starting gateway (Ctrl+C to stop) =="
node gateway/server.js
