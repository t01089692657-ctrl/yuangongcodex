# Company Codex — Desktop App (Electron)

The employee-facing desktop app from the video. One click:

**飞书登录 → 网关签发 Key → 写入托管 Codex 配置 + 同步公司技能 → 启动内置 Codex**

It is a thin shell over `../client/core.js` — the exact same code the CLI uses
and that `npm run demo-feishu` verifies end-to-end. The Feishu **app secret is
never in this app**; login goes through the gateway (PKCE link+poll).

## Develop / run (on your Mac)

```bash
cd desktop
npm install            # downloads Electron
GATEWAY_URL=https://gateway.corp.com npm start
```

The window shows **使用飞书登录**. Clicking it opens the system browser to the
gateway's Feishu login; after you sign in, the app provisions the key, writes
`~/.codex-managed`, syncs skills, and enables **启动 Codex**.

Settings (gear/"Settings" link) let you set the **Gateway URL** and the path to
the **bundled Codex binary**. These persist in the app's userData dir.

## Bundle the Codex binary

Drop the Codex binary the employees should get into `desktop/vendor/codex/`:

```
desktop/vendor/codex/codex          # macOS/Linux (or codex.exe on Windows)
```

`electron-builder` copies it to the app's `Resources/codex/`. At runtime the app
auto-detects it as the launch target (overridable in Settings).

## Build installers

```bash
cd desktop
npm run dist         # -> dist/Company Codex-0.1.0.dmg  (macOS)
# npm run dist:all   # mac + win + linux (needs the respective toolchains)
```

`electron-builder` bundles `../client` and `../skills` into `Resources/app-src`
(see `build.extraResources` in `package.json`), so the packaged app is
self-contained.

## Launching Codex

Codex is a terminal UI, so on macOS the app opens **Terminal.app** running a
short-lived, user-only launch script that injects the issued key + `CODEX_HOME`
and execs the bundled Codex. On Windows/Linux it spawns the binary detached.

## Notes

- **MCP skills** (`company` server) are configured as `command: node …`. If the
  employee machine has no `node`, that one MCP server won't start (Codex still
  runs; `AGENTS.md` + prompts still apply). For a no-node deployment, switch the
  company MCP to a **remote URL** served by the gateway (see the gateway
  `/skills/manifest` `mcpServers[].url` option) — edit once, everyone updates.
- The app holds no long-lived secret. The issued key is revocable at the gateway
  (offboarding / manual), so "leave and it stops working" still holds.
- Requires **Electron ≥ 28** (ESM main process). Pinned to 31 in `package.json`.
