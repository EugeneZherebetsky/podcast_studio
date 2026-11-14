import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(directory, 'key-window.html')).href;

// Deliberately not imported by the desktop shell. No key can reach the child.
export async function openKeyWindow(store) {
  const win = new BrowserWindow({ show: false, width: 650, height: 650,
    webPreferences: { preload: path.join(directory, 'key-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
  const handlers = {
    'keys:list': () => store.list(),
    'keys:set': (name, value) => store.set(name, value),
    'keys:clear': (name) => store.clear(name),
  };
  for (const [channel, action] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== page) return { ok: false };
      try { const value = await action(...args); return channel === 'keys:list' ? { ok: true, value } : { ok: true }; }
      catch { return { ok: false }; }
    });
  }
  win.once('closed', () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try { await win.loadURL(page); } catch (error) { win.destroy(); throw error; }
  return win;
}
