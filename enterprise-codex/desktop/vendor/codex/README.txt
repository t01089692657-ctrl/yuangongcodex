Put your bundled Codex binary here as `codex` (macOS/Linux) or `codex.exe` (Windows).

  desktop/vendor/codex/codex

electron-builder copies this folder to the app's Resources/codex/ at build time,
and the app runs Codex from there (embedded terminal). If no binary is present,
the app falls back to the Codex path configured in Settings, or to a wiring-only
proof. This placeholder file keeps the folder present so `npm run dist` never
fails on a missing resource path.
