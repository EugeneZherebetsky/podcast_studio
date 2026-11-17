// Explicit synthetic-only DPAPI probe; never opens the application or a real profile.
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { USABLE_KEY_NAMES } from './key-activation.mjs';
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
    // Synthetic in-memory activation choice: off, and never read from or saved to a profile.
    let choice = { enabled: false, keys: [] };
    const activation = {
      get: async () => ({ ...choice, usable: USABLE_KEY_NAMES, launch: { state: 'off', names: [] } }),
      set: async (value) => { choice = { enabled: value.enabled === true, keys: [...value.keys] }; },
    };
    const pending = openKeyWindow(store, activation);
    await assert.rejects(openKeyWindow(store, activation));
    const win = await pending;
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await assert.rejects(openKeyWindow(store, activation));
    assert.equal(BrowserWindow.getAllWindows().length, 1);
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
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    const reopened = await openKeyWindow(store, activation);
    assert.equal((await reopened.webContents.executeJavaScript('window.keys.list()')).ok, true);
    reopened.destroy();
    ipcMain.handle('keys:set', () => 'foreign');
    await assert.rejects(openKeyWindow(store, activation));
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(ipcMain._invokeHandlers.has('keys:set'), true);
    assert.equal(ipcMain._invokeHandlers.has('keys:list'), false);
    ipcMain.removeHandler('keys:set');
    const originalLoadURL = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = async () => { throw new Error('synthetic load failure'); };
    try { await assert.rejects(openKeyWindow(store, activation)); } finally { BrowserWindow.prototype.loadURL = originalLoadURL; }
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    const afterFailure = await openKeyWindow(store, activation);
    afterFailure.destroy();
    let finishLoad;
    BrowserWindow.prototype.loadURL = () => new Promise((resolve) => { finishLoad = resolve; });
    const closing = openKeyWindow(store, activation);
    BrowserWindow.getAllWindows()[0].destroy();
    BrowserWindow.prototype.loadURL = originalLoadURL;
    const replacement = await openKeyWindow(store, activation);
    finishLoad();
    await assert.rejects(closing);
    assert.equal((await replacement.webContents.executeJavaScript('window.keys.list()')).ok, true);
    replacement.destroy();
    const fakeFile = path.join(dir, 'fake-keys.bin');
    const fakeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plain) => Buffer.from(plain),
      decryptStringAsync: async (blob) => ({ result: blob.toString() }),
    };
    const fakeStore = createStore(fakeFile, fakeStorage);
    const { KEY_NAMES } = await import('./write-only-store.mjs');
    for (const name of KEY_NAMES.slice(0, -1)) await fakeStore.set(name, '😀'.repeat(4096));
    const before = await readFile(fakeFile);
    await assert.rejects(fakeStore.set(KEY_NAMES.at(-1), '😀'.repeat(4096)));
    assert.deepEqual(await readFile(fakeFile), before);
    assert.equal((await fakeStore.list())[KEY_NAMES.at(-1)], false);
  } finally { await rm(path.join(dir, 'keys.bin'), { force: true }); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  console.log('DPAPI synthetic write-only probe passed');
  app.exit(0);
}).catch((error) => { console.error('DPAPI synthetic write-only probe failed', error); app.exit(1); });
