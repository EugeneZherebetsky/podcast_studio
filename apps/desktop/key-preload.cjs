// Sandboxed Electron preloads require CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('keys', Object.freeze({
  list: () => ipcRenderer.invoke('keys:list'),
  set: (name, value) => ipcRenderer.invoke('keys:set', name, value),
  clear: (name) => ipcRenderer.invoke('keys:clear', name),
}));
