#!/usr/bin/env bash
# End-to-end demo: reproduces every effect from the video, offline.
#   mock upstream + gateway -> client provisions & wires Codex -> usage/leaderboard
#   -> Feishu offboarding webhook -> revoked key is instantly rejected -> MCP skills
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export DATA_DIR="$ROOT/gateway/data/demo"
export SEED_FILE="$ROOT/gateway/data/employees.seed.json"
export UPSTREAM_BASE_URL="http://127.0.0.1:8091/v1"
export UPSTREAM_API_KEY="mock-upstream-key"
export FEISHU_WEBHOOK_SECRET="feishu-dev-secret"
export SSO_SHARED_SECRET="sso-dev-secret"
export ADMIN_TOKEN="admin-dev-token"
export GATEWAY_PORT="8080"
GW="http://127.0.0.1:8080"
rm -rf "$DATA_DIR"; mkdir -p "$DATA_DIR"

echo "== starting mock upstream + gateway =="
node mock-upstream/server.js & MOCK_PID=$!
node gateway/server.js       & GW_PID=$!
cleanup() { kill "$MOCK_PID" "$GW_PID" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 40); do curl -sf "$GW/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

echo; echo "== employees launch the client (SSO -> key -> Codex config -> skills -> run) =="
for e in alice bob carol; do
  node client/launcher.js --provider mock --email "$e@corp.com" --gateway "$GW" --codex-home "$DATA_DIR/codex-$e" --simulate
done
# Bob is a power user — a couple more turns so the leaderboard varies.
node client/launcher.js --provider mock --email "bob@corp.com" --gateway "$GW" --codex-home "$DATA_DIR/codex-bob" --simulate >/dev/null
node client/launcher.js --provider mock --email "bob@corp.com" --gateway "$GW" --codex-home "$DATA_DIR/codex-bob" --simulate >/dev/null

echo; echo "== what the client wrote for Alice (managed CODEX_HOME) =="
echo "--- config.toml ---"; cat "$DATA_DIR/codex-alice/config.toml"
echo "--- auth.json ---";   cat "$DATA_DIR/codex-alice/auth.json"; echo
echo "--- synced skills ---"; ls -1 "$DATA_DIR/codex-alice" "$DATA_DIR/codex-alice/prompts"

echo; echo "== admin leaderboard (static automation token) =="
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$GW/admin/leaderboard"; echo

echo; echo "== manager backend: Feishu SSO login + manager/employee separation =="
COOKIES="$DATA_DIR/mgr.cookies"
echo -n "  employee bob tries to open the manager console -> HTTP "
curl -s -o /dev/null -w "%{http_code}  (denied: not a manager)\n" -c "$COOKIES" -X POST "$GW/auth/admin-login/mock" -H 'content-type: application/json' -d '{"email":"bob@corp.com"}'
echo -n "  manager alice logs in via Feishu -> HTTP "
curl -s -o /dev/null -w "%{http_code}\n" -c "$COOKIES" -X POST "$GW/auth/admin-login/mock" -H 'content-type: application/json' -d '{"email":"alice@corp.com"}'
echo -n "  who am I: "; curl -s -b "$COOKIES" "$GW/auth/admin/me"; echo
echo -n "  manager reads leaderboard with session cookie -> HTTP "
curl -s -o /dev/null -w "%{http_code}\n" -b "$COOKIES" "$GW/admin/leaderboard"
echo -n "  no session at all -> HTTP "
curl -s -o /dev/null -w "%{http_code}  (login required)\n" "$GW/admin/leaderboard"

echo; echo "== offboarding: prove a live key dies the instant HR marks 离职 =="
ASSERT=$(node -e 'const c=require("crypto");const e="alice@corp.com";const p=Buffer.from(JSON.stringify({email:e,exp:Math.floor(Date.now()/1000)+120})).toString("base64url");process.stdout.write(p+"."+c.createHmac("sha256",process.env.SSO_SHARED_SECRET).update(p).digest("hex"))')
LOGIN=$(curl -s -X POST "$GW/auth/login" -H 'content-type: application/json' -d "{\"assertion\":\"$ASSERT\",\"provider\":\"mock\"}")
KEY=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).api_key))' <<<"$LOGIN")
echo "alice key: ${KEY:0:16}…"
echo -n "  request BEFORE offboarding -> HTTP "
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/v1/responses" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gpt-5-codex","input":"hi"}'

# Nested Feishu event shape + timestamped signature (exercises robust parsing + replay guard).
TS=$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))')
BODY='{"schema":"2.0","event":{"object":{"email":"alice@corp.com","status":"离职"}}}'
SIG=$(node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.env.FEISHU_WEBHOOK_SECRET).update(process.argv[1]+"."+process.argv[2]).digest("hex"))' "$TS" "$BODY")
echo -n "  Feishu webhook -> "; curl -s -X POST "$GW/webhooks/feishu/offboarding" -H "x-timestamp: $TS" -H "x-signature: $SIG" -H 'content-type: application/json' -d "$BODY"; echo
echo -n "  SAME key AFTER offboarding -> HTTP "
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$GW/v1/responses" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gpt-5-codex","input":"hi"}'

echo; echo "== company MCP skills smoke test =="
node tools/mcp-smoke.js

echo; echo "== done. dashboard: $GW/  (admin token: $ADMIN_TOKEN) =="
