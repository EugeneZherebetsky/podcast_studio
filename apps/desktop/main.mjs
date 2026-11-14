import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { allowedExternal, loginItem, startServer } from './supervisor.mjs';

app.setName(app.isPackaged ? 'Podcast Studio Installer Prototype' : 'Podcast Studio Desktop');
app.enableSandbox();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resources = app.isPackaged ? process.resourcesPath : path.join(root, 'dist-desktop');
const home = app.getPath('userData');
let window;
let tray;
let server;
let quitting = false;
let failed = false;

function show() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function external(url) {
  if (!allowedExternal(url)) return;
  const answer = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0,
    message: 'Open this HTTPS link in your system browser?', detail: url });
  if (answer === 1) void shell.openExternal(url).catch(() => {});
}
function menu() {
  return Menu.buildFromTemplate([
    { label: 'Open Podcast Studio', click: show },
    loginItem(app, () => tray.setContextMenu(menu())),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}
function error(message) {
  if (failed || quitting) return;
  failed = true;
  if (window && !window.isDestroyed()) window.destroy();
  dialog.showErrorBox('Podcast Studio', `${message}\nNo automatic restart will be attempted. Check the recovery guidance before starting again.`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    if (window && !window.isDestroyed()) window.destroy();
    void (server ? server.stop() : Promise.resolve(true)).then((clean) => {
      if (!clean) dialog.showErrorBox('Podcast Studio', server?.terminationConfirmed() ? 'The server did not shut down cleanly. Manual recovery may be required; see the setup guidance.' : 'The server may still be running: termination could not be confirmed. Do not start another server; check the setup recovery guidance.');
    }).finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    await mkdir(home, { recursive: true });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const mark = (x >= 4 && x <= 5 && y >= 3 && y <= 12) ||
        (x >= 6 && x <= 10 && (y === 3 || y === 7)) || (x === 10 && y >= 4 && y <= 6);
      pixels[i] = mark ? 255 : 125; pixels[i + 1] = mark ? 255 : 65;
      pixels[i + 2] = mark ? 255 : 32; pixels[i + 3] = 255;
    }
    const image = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
    tray = new Tray(image); tray.setToolTip('Podcast Studio'); tray.setContextMenu(menu()); tray.on('click', show);
    server = startServer(resources, home, () => error('The server stopped unexpectedly.'));
    const port = await server.ready;
    if (failed || quitting) return;
    const origin = `http://127.0.0.1:${port}`;
    window = new BrowserWindow({ width: 1200, height: 800, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => {
      try { if (new URL(event.url).origin === origin) return; } catch { /* blocked */ }
      event.preventDefault(); if (event.isMainFrame) external(event.url);
    });
    window.webContents.on('will-redirect', (event) => {
      try { if (new URL(event.url).origin === origin) return; } catch { /* blocked */ }
      event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    await window.loadURL(origin); show();
  }).catch(async () => {
    if (server) await server.stop();
    error(server && !server.terminationConfirmed()
      ? 'The desktop server could not start, and termination could not be confirmed. It may still be running; do not start another server.'
      : 'The desktop server could not start.');
  });
}
