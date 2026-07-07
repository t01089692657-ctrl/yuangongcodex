// Electron main process for the Company Codex desktop app.
// Thin shell over ../client/core.js (the same code the CLI uses and that the
// offline demo verifies): Feishu SSO -> provision key -> write managed Codex
// config + sync skills -> launch the bundled Codex.
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where client/ and skills/ live. In dev that's the enterprise-codex root one
// level up; in a packaged build electron-builder copies them under Resources.
const clientDir = app.isPackaged ? path.join(process.resourcesPath, 'app-src') : path.join(__dirname, '..');
const corePath = path.join(clientDir, 'client', 'core.js');
const { feishuLogin, setupCodex, proveWiring } = await import(pathToFileURL(corePath).href);

// A bundled codex binary shipped in Resources/codex, if present.
const bundledCodex = app.isPackaged ? path.join(process.resourcesPath, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex') : (process.env.CODEX_BIN || '');

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
let current = null; // { prov, paths } after a successful login
const emit = (m) => win?.webContents.send('log', m);

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 640, resizable: false, title: 'Company Codex',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('get-config', () => loadSettings());
ipcMain.handle('save-config', (_e, s) => saveSettings(s));

ipcMain.handle('login', async () => {
  const s = loadSettings();
  const prov = await feishuLogin({ gatewayUrl: s.gatewayUrl, openBrowser: (url) => shell.openExternal(url), onStatus: emit });
  const { skills, paths } = await setupCodex({ prov, gatewayUrl: s.gatewayUrl, codexHome: s.codexHome, clientDir, onStatus: emit });
  current = { prov, paths };
  emit('ready — you can launch Codex');
  return { employee: prov.employee, skills: skills.written, mcp: Object.keys(skills.mcpServers), model: prov.model };
});

ipcMain.handle('launch', async () => {
  if (!current) throw new Error('sign in first');
  const s = loadSettings();
  const { prov, paths } = current;
  if (s.codexBin && fs.existsSync(s.codexBin)) {
    launchInTerminal({ codexBin: s.codexBin, codexHome: s.codexHome, envKey: paths.envKey, apiKey: prov.api_key });
    return { launched: true };
  }
  const proof = await proveWiring({ prov, envKey: paths.envKey });
  return { launched: false, proof: { ok: proof.ok, status: proof.status } };
});

// Codex is a terminal UI. On macOS we open Terminal.app running a short-lived
// launch script (user-only perms) that injects the key + CODEX_HOME then execs
// the bundled Codex. Elsewhere we spawn it detached.
function launchInTerminal({ codexBin, codexHome, envKey, apiKey }) {
  if (process.platform === 'darwin') {
    const script = path.join(app.getPath('userData'), 'launch-codex.command');
    fs.writeFileSync(script,
      `#!/bin/bash\nexport CODEX_HOME=${JSON.stringify(codexHome)}\nexport ${envKey}=${JSON.stringify(apiKey)}\nexec ${JSON.stringify(codexBin)}\n`,
      { mode: 0o700 });
    spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const env = { ...process.env, CODEX_HOME: codexHome, [envKey]: apiKey };
    spawn(codexBin, [], { env, detached: true, stdio: 'ignore' }).unref();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
