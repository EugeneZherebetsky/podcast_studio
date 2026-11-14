import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(directory, 'key-window.html')).href;

let activeWindow = null;

// Deliberately not imported by the desktop shell. No key can reach the child.
export async function openKeyWindow(store) {
  if (activeWindow) throw new Error('Key window already open');
  const owner = {};
  activeWindow = owner;
  let win;
  const registered = [];
  const cleanup = () => {
    for (const channel of registered.splice(0)) ipcMain.removeHandler(channel);
    if (activeWindow === owner) activeWindow = null;
  };
  try {
    win = new BrowserWindow({ show: false, width: 650, height: 650,
      webPreferences: { preload: path.join(directory, 'key-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    win.once('closed', cleanup);
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
      registered.push(channel);
    }
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(page);
    if (win.isDestroyed()) throw new Error('Key window closed during loading');
    return win;
  } catch (error) {
    if (win && !win.isDestroyed()) win.destroy();
    cleanup();
    throw error;
  }
}
