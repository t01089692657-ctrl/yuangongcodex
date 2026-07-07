# Company Codex — Desktop App (Electron)

The employee-facing desktop app from the video. One click:

**飞书登录 → 网关签发 Key → 写入托管 Codex 配置 + 同步公司技能 → Codex 直接在 App 窗口里跑**

Codex runs **inside the app window** as an embedded terminal (xterm.js +
node-pty) — the employee never opens a separate terminal or touches any config.
It is a thin shell over `../client/core.js` — the exact same code the CLI uses
and that `npm run demo-feishu` verifies end-to-end. The Feishu **app secret is
never in this app**; login goes through the gateway (PKCE link+poll).

## Develop / run (on your Mac)

```bash
cd desktop
npm install            # downloads Electron, builds node-pty, vendors xterm
GATEWAY_URL=https://gateway.corp.com npm start
```

`npm install` runs `postinstall` which (1) refreshes the xterm assets into
`renderer/vendor/` and (2) runs `electron-rebuild` so **node-pty** (a native
module) matches Electron's ABI. If node-pty can't build/load, the app still
works — it falls back to launching Codex in an external terminal.

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

## Point the app at your gateway (so employees configure nothing)

Before building, set your Mac mini's LAN address in `desktop/app-config.json`:

```json
{ "gatewayUrl": "http://192.168.1.50:8080", "codexBin": "" }
```

This is baked into the build and used as the default, so employees never type a
URL. (They can still override it under Settings, and `GATEWAY_URL` env wins in dev.)

## Build installers

```bash
cd desktop
# 1) set gatewayUrl in app-config.json  2) drop the codex binary in vendor/codex/
npm install
npm run dist         # -> dist/Company Codex-0.1.0.dmg  (macOS)
# npm run dist:all   # mac + win + linux (needs the respective toolchains)
```

`electron-builder` bundles `../client` and `../skills` into `Resources/app-src`
(see `build.extraResources` in `package.json`), so the packaged app is
self-contained.

## Internal distribution (no App Store / no notarization)

For internal-only use you do **not** need the Mac App Store, an Apple Developer
account, or notarization. Just build the `.dmg` and hand it to employees (share
drive / MDM / internal download page).

One caveat: an **unsigned** app triggers macOS **Gatekeeper** on first open.
Options, easiest first:

- **Right-click → Open** once (then "Open" in the dialog). Per-user, one-time.
- Strip the quarantine flag before sharing:
  `xattr -dr com.apple.quarantine "dist/mac/Company Codex.app"`
- **Ad-hoc sign** so it launches cleanly on Apple Silicon:
  `codesign --deep --force -s - "dist/mac/Company Codex.app"`
- If you have an **Apple Developer ID** cert (recommended, no App Store needed),
  set it and electron-builder signs automatically:
  `export CSC_NAME="Developer ID Application: Your Co (TEAMID)"`
- **MDM (Jamf/Kandji/Intune)** push bypasses the prompt entirely — the cleanest
  path for a fleet.

To force an explicitly-unsigned build (skip any auto-discovered cert), run with
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist`.

## Running Codex (embedded)

After sign-in the app spawns the bundled Codex in a **node-pty** pseudo-terminal
and streams its I/O to an **xterm.js** terminal filling the window — a real
desktop interface, no external terminal. The issued key is injected via the
env var + `CODEX_HOME` into the pty's environment only.

If node-pty is unavailable or no Codex binary is configured, it falls back to
opening Terminal.app (macOS) via a short-lived, user-only launch script, or a
gateway-wiring proof if there's no binary at all.

## Vendored assets

`renderer/vendor/` holds xterm's JS/CSS (MIT, see `XTERM-LICENSE`), committed so
the renderer loads them under its strict CSP (`script-src 'self'`). They're
refreshed from `node_modules` by `scripts/vendor-xterm.mjs` on `postinstall`.

## Notes

- **MCP skills** (`company` server) are configured as `command: node …`. If the
  employee machine has no `node`, that one MCP server won't start (Codex still
  runs; `AGENTS.md` + prompts still apply). For a no-node deployment, switch the
  company MCP to a **remote URL** served by the gateway (see the gateway
  `/skills/manifest` `mcpServers[].url` option) — edit once, everyone updates.
- The app holds no long-lived secret. The issued key is revocable at the gateway
  (offboarding / manual), so "leave and it stops working" still holds.
- Requires **Electron ≥ 28** (ESM main process). Pinned to 31 in `package.json`.
