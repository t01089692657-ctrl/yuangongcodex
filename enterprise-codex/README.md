# Enterprise Codex Platform

Give your employees OpenAI Codex, but only through your product: access is
provisioned via SSO, metered and revocable at a gateway, and the company pushes
its own "skills" (AGENTS.md + prompt commands + MCP tools) onto every Codex.
When an employee leaves, their access dies on the next request.

This is a **runnable reference implementation** of the two-plane design in
[`../docs/enterprise-codex-platform.md`](../docs/enterprise-codex-platform.md).
Zero external dependencies — Node ≥ 20 only.

```
enterprise-codex/
├── gateway/          Plane A — access & billing (auth, metered proxy, revoke, webhook)
│   ├── server.js       HTTP router
│   ├── auth.js         key issuance / resolution / offboarding
│   ├── proxy.js        metered reverse proxy to your OWN upstream
│   ├── store.js        JSON-file store (swap for Postgres/Redis in prod)
│   └── data/employees.seed.json
├── client/           Plane B — the desktop-app logic from the video
│   ├── launcher.js     SSO → provision key → write config → sync skills → launch Codex
│   ├── codex-config.js writes ~/.codex config.toml + auth.json
│   └── skills-sync.js  pulls AGENTS.md + prompts + MCP manifest
├── skills/           what gets pushed onto every employee's Codex
│   ├── AGENTS.md
│   ├── prompts/        slash-command prompts
│   └── mcp/company-mcp.js   push-type tools (edit once → everyone updates)
├── mock-upstream/    fake OpenAI-compatible provider so the demo runs offline
├── admin/dashboard.html   usage leaderboard + one-click offboarding
├── tools/mcp-smoke.js
└── scripts/demo.sh   full end-to-end demo
```

## Run the demo

```bash
cd enterprise-codex
npm run demo        # or: bash scripts/demo.sh
```

It starts the mock upstream + gateway, has three employees launch the client
(each provisions a key, gets Codex configured, syncs skills, makes a proof
request), prints the leaderboard, fires the Feishu **离职** webhook for one
employee, and shows that employee's **still-valid key now returns 401** — the
core "leave and it stops working" guarantee — then smoke-tests the MCP server.

## Run the pieces individually

```bash
# 1) gateway (point UPSTREAM_* at your OWN OpenAI/Azure endpoint in prod)
UPSTREAM_BASE_URL=http://127.0.0.1:8091/v1 npm run gateway
npm run mock                                   # demo upstream

# 2) an employee launches Codex through the client
node client/launcher.js --provider mock --email alice@corp.com \
     --gateway http://127.0.0.1:8080 --codex-home ~/.codex-managed --simulate
# real client: set CODEX_BIN=/path/to/bundled/codex and drop --simulate

# 3) admin dashboard
open http://127.0.0.1:8080/     # admin token: admin-dev-token
```

## What the client writes into the managed `CODEX_HOME`

`config.toml` (custom provider pointed at your gateway):

```toml
model = "gpt-5-codex"
model_provider = "mycompany"
[model_providers.mycompany]
base_url = "https://gateway.mycompany.com/v1"
wire_api = "responses"
env_key  = "MYCOMPANY_CODEX_KEY"
[mcp_servers.company]
command = "node"
args = [".../skills/mcp/company-mcp.js"]
```

The issued key is injected via `MYCOMPANY_CODEX_KEY` at launch (and mirrored into
`auth.json` for parity with the video). `AGENTS.md` and `prompts/` are synced in.

## Turning this into production

- **Compliance first.** Point `UPSTREAM_*` at your company's **own** OpenAI /
  Azure OpenAI key or enterprise agreement. Do **not** pool personal
  ChatGPT/Codex subscription accounts — it violates provider ToS and risks bans.
- **SSO.** Replace the `mock` provider in `client/launcher.js` with a real OIDC
  flow (Feishu/Lark, WeCom, Okta) and take the email from the *verified* id_token
  in `/auth/login`, not the request body.
- **Store.** Swap `store.js` for Postgres + Redis; keep the same interface.
- **Enforcement.** A relay makes access revocable but the local config is
  editable. For "can only be used through our product," run Codex inside a
  managed devcontainer / cloud dev env, or manage the device (MDM). See the
  strength ladder in the design doc.
- **Short-lived keys.** Set `KEY_TTL_SECONDS` and have the client refresh via SSO
  so a departed employee's session dies within minutes even before the webhook.
```
