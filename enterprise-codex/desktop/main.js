// Electron main process for the Company Codex desktop app.
// Employees sign in with Feishu and get Codex running INSIDE the app window
// (embedded terminal via node-pty + xterm). Thin shell over ../client/core.js —
// the same code the CLI uses and the offline demo verifies.
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// node-pty is a native module; if it isn't built we fall back to an external
// terminal so the app still works.
let pty = null;
try { pty = require('node-pty'); } catch (e) { console.warn('[codex-app] node-pty unavailable, using external-terminal fallback:', e.message); }

// Where client/ and skills/ live. In dev that's the enterprise-codex root one
// level up; in a packaged build electron-builder copies them under Resources.
const clientDir = app.isPackaged ? path.join(process.resourcesPath, 'app-src') : path.join(__dirname, '..');
const corePath = path.join(clientDir, 'client', 'core.js');
const { feishuLogin, setupCodex, proveWiring } = await import(pathToFileURL(corePath).href);

const bundledCodex = app.isPackaged
  ? path.join(process.resourcesPath, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex')
  : (process.env.CODEX_BIN || '');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  const defaults = {
    gatewayUrl: process.env.GATEWAY_URL || 'http://127.0.0.1:8080',
    codexBin: bundledCodex && fs.existsSync(bundledCodex) ? bundledCodex : (process.env.CODEX_BIN || ''),
    codexHome: path.join(app.getPath('home'), '.codex-managed'),
  };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return defaults; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  return loadSettings();
}

let win;
let current = null;   // { prov, paths } after login
let ptyProc = null;   // the running Codex pty
const emit = (m) => win?.webContents.send('log', m);

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 680, minWidth: 620, minHeight: 460, title: 'Company Codex',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', killPty);
}

function killPty() { try { ptyProc?.kill(); } catch { /* already gone */ } ptyProc = null; }

ipcMain.handle('get-config', () => loadSettings());
ipcMain.handle('save-config', (_e, s) => saveSettings(s));

ipcMain.handle('login', async () => {
  const s = loadSettings();
  const prov = await feishuLogin({ gatewayUrl: s.gatewayUrl, openBrowser: (url) => shell.openExternal(url), onStatus: emit });
  const { skills, paths } = await setupCodex({ prov, gatewayUrl: s.gatewayUrl, codexHome: s.codexHome, clientDir, onStatus: emit });
  current = { prov, paths };
  emit('ready — launching Codex');
  return { employee: prov.employee, skills: skills.written, mcp: Object.keys(skills.mcpServers), model: prov.model, canEmbed: !!pty };
});

// Start Codex inside the app as a pty; stream its I/O to the renderer's xterm.
ipcMain.handle('start-terminal', (_e, { cols = 80, rows = 24 } = {}) => {
  if (!current) throw new Error('sign in first');
  const s = loadSettings();
  const { prov, paths } = current;
  if (!pty || !s.codexBin || !fs.existsSync(s.codexBin)) {
    return { mode: 'fallback', reason: !pty ? 'node-pty not built' : 'no Codex binary configured' };
  }
  killPty();
  ptyProc = pty.spawn(s.codexBin, [], {
    name: 'xterm-color', cols, rows, cwd: app.getPath('home'),
    env: { ...process.env, CODEX_HOME: s.codexHome, [paths.envKey]: prov.api_key, TERM: 'xterm-256color' },
  });
  ptyProc.onData((d) => win?.webContents.send('pty-data', d));
  ptyProc.onExit(({ exitCode }) => { ptyProc = null; win?.webContents.send('pty-exit', exitCode); });
  return { mode: 'embedded' };
});
ipcMain.on('pty-input', (_e, data) => { try { ptyProc?.write(data); } catch { /* pty gone */ } });
ipcMain.on('pty-resize', (_e, { cols, rows }) => { try { ptyProc?.resize(cols, rows); } catch { /* pty gone */ } });
ipcMain.handle('stop-terminal', () => { killPty(); return true; });

// Fallback when there's no pty/binary: prove the wiring, or open Terminal.app.
ipcMain.handle('launch-external', async () => {
  if (!current) throw new Error('sign in first');
  const s = loadSettings();
  const { prov, paths } = current;
  if (s.codexBin && fs.existsSync(s.codexBin)) { launchInTerminal({ codexBin: s.codexBin, codexHome: s.codexHome, envKey: paths.envKey, apiKey: prov.api_key }); return { launched: true }; }
  const proof = await proveWiring({ prov, envKey: paths.envKey });
  return { launched: false, proof: { ok: proof.ok, status: proof.status } };
});

// Single-quote every interpolated value so $, backticks, etc. can't be shell-
// interpreted (defense-in-depth even though values are trusted).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const safeEnvName = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : 'MYCOMPANY_CODEX_KEY');
function launchInTerminal({ codexBin, codexHome, envKey, apiKey }) {
  if (process.platform === 'darwin') {
    const script = path.join(app.getPath('userData'), 'launch-codex.command');
    fs.writeFileSync(script, `#!/bin/bash\nexport CODEX_HOME=${shq(codexHome)}\nexport ${safeEnvName(envKey)}=${shq(apiKey)}\nexec ${shq(codexBin)}\n`, { mode: 0o700 });
    spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(codexBin, [], { env: { ...process.env, CODEX_HOME: codexHome, [envKey]: apiKey }, detached: true, stdio: 'ignore' }).unref();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { killPty(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
