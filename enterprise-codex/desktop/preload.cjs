// Preload bridge (CommonJS, runs sandboxed). Exposes a minimal, safe API to the
// renderer — no Node access leaks to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (s) => ipcRenderer.invoke('save-config', s),
  login: () => ipcRenderer.invoke('login'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),

  // Embedded Codex terminal
  startTerminal: (size) => ipcRenderer.invoke('start-terminal', size),
  stopTerminal: () => ipcRenderer.invoke('stop-terminal'),
  ptyInput: (data) => ipcRenderer.send('pty-input', data),
  ptyResize: (size) => ipcRenderer.send('pty-resize', size),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, code) => cb(code)),

  // Fallback launch (external Terminal / wiring proof)
  launchExternal: () => ipcRenderer.invoke('launch-external'),
});
