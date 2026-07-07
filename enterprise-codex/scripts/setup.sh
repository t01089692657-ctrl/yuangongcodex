#!/usr/bin/env bash
# One-time setup: generate a .env with fresh secrets. macOS + Linux friendly.
#   ./scripts/setup.sh          # trial posture (mock Feishu login enabled)
#   ./scripts/setup.sh prod     # production posture (real Feishu SSO only)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-trial}"
if [ -f .env ]; then
  echo ".env already exists — not overwriting. Delete it first to regenerate."
  exit 0
fi

gen() { openssl rand -hex 32; }
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"

if [ "$MODE" = "prod" ]; then DEMO=false; SECURE=true; else DEMO=true; SECURE=false; fi

cat > .env <<EOF
# ==== Enterprise Codex Gateway — generated $(date '+%Y-%m-%d %H:%M') ====
# KEEP THIS FILE SECRET (chmod 600). Never commit it.

# --- Network ---
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=8080
# Base URL employees' Codex will be pointed at (must be reachable from their machines):
GATEWAY_PUBLIC_URL=http://${LAN_IP}:8080

# --- Upstream model provider (COMPLIANT path = your OWN OpenAI/Azure key) ---
# For a first trial you can run with the bundled mock instead: scripts/start.sh --with-mock-upstream
UPSTREAM_BASE_URL=https://api.openai.com/v1
UPSTREAM_API_KEY=sk-REPLACE-with-your-company-openai-or-azure-key
CODEX_MODEL=gpt-5-codex

# --- Secrets (auto-generated; do not share) ---
ADMIN_TOKEN=$(gen)
ADMIN_SESSION_SECRET=$(gen)
SSO_SHARED_SECRET=$(gen)
FEISHU_WEBHOOK_SECRET=$(gen)

# --- Manager backend ---
# DEMO_MODE=true enables the email-based mock login (stands in for Feishu SSO).
# TRIAL ONLY — run on a trusted network, then wire real Feishu SSO and set false.
DEMO_MODE=${DEMO}
# COOKIE_SECURE: set true when serving over HTTPS
COOKIE_SECURE=${SECURE}
ADMIN_SESSION_TTL_SECONDS=3600
EOF

chmod 600 .env
echo "Wrote .env ($MODE posture) with fresh secrets at: $(pwd)/.env"
echo "LAN URL for employees: http://${LAN_IP}:8080"
[ "$MODE" = "trial" ] && echo "NOTE: trial mode enables the mock manager login — only use on a trusted network."
echo "Next: edit UPSTREAM_API_KEY (or use --with-mock-upstream), then: scripts/start.sh"
