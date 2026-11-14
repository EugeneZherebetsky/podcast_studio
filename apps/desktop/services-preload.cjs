// Sandboxed Electron preloads require CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('services', {
  read: () => ipcRenderer.invoke('local-services', 'read'),
  save: (value) => ipcRenderer.invoke('local-services', 'save', value),
  close: () => ipcRenderer.send('local-services-close'),
});
