// Preload bridge (CommonJS, runs in the sandbox). Exposes a minimal, safe API
// to the renderer — no Node access leaks to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (s) => ipcRenderer.invoke('save-config', s),
  login: () => ipcRenderer.invoke('login'),
  launch: () => ipcRenderer.invoke('launch'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
});
