// Explicit synthetic-only DPAPI probe; never opens the application or a real profile.
import { app, BrowserWindow, safeStorage } from 'electron';
import { openKeyWindow } from './key-window.mjs';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './write-only-store.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'key-dpapi-probe-'));
app.setPath('userData', dir);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const file = path.join(dir, 'keys.bin');
    const store = createStore(file, safeStorage);
    const win = await openKeyWindow(store);
    const result = await win.webContents.executeJavaScript(`window.keys.set('OPENAI_API_KEY', 'synthetic-dpapi-probe')`);
    if (!result.ok) throw new Error();
    if ((await readFile(file)).includes(Buffer.from('synthetic-dpapi-probe'))) throw new Error();
    const list = await win.webContents.executeJavaScript('window.keys.list()');
    if (!list.ok || !list.value.OPENAI_API_KEY || (await win.webContents.executeJavaScript('Object.keys(window.keys)')).includes('read')) throw new Error();
    const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(import.meta.dirname, 'key-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await other.loadURL('data:text/html,<title>untrusted</title>');
    if ((await other.webContents.executeJavaScript('window.keys.list()')).ok) throw new Error();
    other.destroy();
    if (!(await win.webContents.executeJavaScript(`window.keys.clear('OPENAI_API_KEY')`)).ok) throw new Error();
    if ((await store.list()).OPENAI_API_KEY) throw new Error();
    win.destroy();
  } finally { await rm(path.join(dir, 'keys.bin'), { force: true }); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  console.log('DPAPI synthetic write-only probe passed');
  app.exit(0);
}).catch(() => { console.error('DPAPI synthetic write-only probe failed'); app.exit(1); });
