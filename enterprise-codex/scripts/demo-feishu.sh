#!/usr/bin/env bash
# Exercises the REAL Feishu OAuth code path end-to-end, offline, against the
# bundled mock-feishu IdP. No real Feishu credentials required.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export DATA_DIR="$ROOT/gateway/data/demo-feishu"
export SEED_FILE="$ROOT/gateway/data/employees.seed.json"
export UPSTREAM_BASE_URL="http://127.0.0.1:8091/v1"
export UPSTREAM_API_KEY="mock-upstream-key"
export GATEWAY_PUBLIC_URL="http://127.0.0.1:8080"
export DEMO_MODE="true"          # allows demo_email passthrough to mock-feishu
export COOKIE_SECURE="false"
# Point Feishu OAuth at the mock IdP:
export FEISHU_APP_ID="mock-app"
export FEISHU_APP_SECRET="mock-secret"
export FEISHU_AUTHORIZE_URL="http://127.0.0.1:8092/authorize"
export FEISHU_TOKEN_URL="http://127.0.0.1:8092/oauth/token"
export FEISHU_USERINFO_URL="http://127.0.0.1:8092/user_info"
export FEISHU_REDIRECT_URI="http://127.0.0.1:8080/auth/feishu/callback"
GW="http://127.0.0.1:8080"
rm -rf "$DATA_DIR"; mkdir -p "$DATA_DIR"

echo "== starting mock-upstream, mock-feishu, gateway =="
node mock-upstream/server.js & P1=$!
node mock-feishu/server.js    & P2=$!
node gateway/server.js        & P3=$!
cleanup() { kill "$P1" "$P2" "$P3" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 40); do curl -sf "$GW/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

echo; echo "== EMPLOYEE desktop flow: real Feishu OAuth (PKCE link+poll) =="
echo "   (carol signs in via Feishu; browser step driven headlessly)"
node client/launcher.js --provider feishu --demo-email carol@corp.com \
  --gateway "$GW" --codex-home "$DATA_DIR/codex-carol" --headless-open --simulate

echo; echo "== MANAGER console flow: Feishu login sets a manager session =="
JAR="$DATA_DIR/mgr.jar"
echo -n "  manager alice via Feishu -> "; curl -s -L -c "$JAR" -o /dev/null -w "HTTP %{http_code}\n" "$GW/auth/feishu/start?intent=manager&demo_email=alice@corp.com"
echo -n "  /auth/admin/me with cookie -> "; curl -s -b "$JAR" "$GW/auth/admin/me"; echo
echo -n "  leaderboard with cookie -> "; curl -s -b "$JAR" -o /dev/null -w "HTTP %{http_code}\n" "$GW/admin/leaderboard"

echo; echo "== employee (bob) is NOT a manager: manager-intent login is denied =="
JAR2="$DATA_DIR/bob.jar"
echo -n "  bob via Feishu (manager intent) -> "; curl -s -L -c "$JAR2" -o /dev/null -w "HTTP %{http_code} (403 = denied)\n" "$GW/auth/feishu/start?intent=manager&demo_email=bob@corp.com"
echo -n "  bob has NO manager session -> "; curl -s -b "$JAR2" -o /dev/null -w "HTTP %{http_code} (401 = no session)\n" "$GW/admin/leaderboard"

echo; echo "== done =="
