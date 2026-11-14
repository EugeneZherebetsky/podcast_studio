import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { allowedExternal, loginItem, startServer } from './supervisor.mjs';
import { readTools, saveTools } from './ffmpeg-settings.mjs';
import { openKeyWindow } from './key-window.mjs';
import { createStore } from './write-only-store.mjs';
import { readPiper, savePiper, readServices, saveServices } from './local-settings.mjs';

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
let selectingTools = false;
let selectingPiper = false;
let servicesWindow;

function configureServices() {
  if (servicesWindow && !servicesWindow.isDestroyed()) { servicesWindow.focus(); return; }
  servicesWindow = new BrowserWindow({ width: 650, height: 620, title: 'Local services',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(root, 'apps/desktop/services-preload.cjs') } });
  servicesWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  servicesWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void servicesWindow.loadFile(path.join(root, 'apps/desktop/services.html'));
}
function isServicesSender(event) {
  return servicesWindow && !servicesWindow.isDestroyed() && event.sender === servicesWindow.webContents && event.senderFrame === servicesWindow.webContents.mainFrame;
}
ipcMain.handle('local-services', async (event, action, value) => {
  if (!isServicesSender(event)) throw new Error('Unauthorized');
  if (action === 'read') return readServices(home);
  if (action === 'save') {
    try { await saveServices(home, value); return 'Saved. Finish any jobs, then quit and reopen Podcast Studio to apply.'; }
    catch (err) { return err.message; }
  }
  throw new Error('Invalid action');
});
ipcMain.on('local-services-close', (event) => { if (isServicesSender(event)) servicesWindow.close(); });

async function selectPiper() {
  if (selectingPiper) return;
  selectingPiper = true;
  try {
    const answer = await dialog.showMessageBox({ type: 'info', buttons: ['Choose files', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Connect an existing Piper installation',
      detail: 'Piper and voices are not bundled. Select only a trusted Piper executable from the Piper home venv folder and two voice ONNX files from its voices folder. Each voice needs its matching .onnx.json file. Review the engine and voice licenses. Piper will run during generation. Changes apply after quitting and reopening; finish any jobs first.' });
    if (answer.response !== 0) return;
    const selected = {};
    for (const [key, title] of [['executable', 'Select Piper in venv'], ['native', 'Select English voice ONNX'], ['hu', 'Select Hungarian voice ONNX']]) {
      const result = await dialog.showOpenDialog({ title, properties: ['openFile'] });
      if (result.canceled || result.filePaths.length !== 1) return;
      selected[key] = result.filePaths[0];
    }
    await savePiper(home, selected);
    await dialog.showMessageBox({ message: 'Piper settings saved.', detail: 'Finish any jobs, then quit and reopen Podcast Studio to use these settings.' });
  } catch (err) { dialog.showErrorBox('Piper selection failed', String(err.message)); }
  finally { selectingPiper = false; }
}

async function selectTools() {
  if (selectingTools) return null;
  selectingTools = true;
  try {
    const answer = await dialog.showMessageBox({ type: 'info', buttons: ['Choose files', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'FFmpeg is not included in this prototype.',
      detail: 'Choose trusted ffmpeg and ffprobe executable files you obtained separately. The app will run them during audio generation. Required: loudnorm, AAC encoding and the ipod muxer. File selection alone does not verify compatibility.' });
    if (answer.response !== 0) return null;
    const tools = {};
    for (const name of ['ffmpeg', 'ffprobe']) {
      const result = await dialog.showOpenDialog({ title: `Select ${name}${process.platform === 'win32' ? '.exe' : ''}`, properties: ['openFile'] });
      if (result.canceled || result.filePaths.length !== 1) return null;
      tools[name] = result.filePaths[0];
    }
    await saveTools(home, tools);
    return tools;
  } catch (err) {
    dialog.showErrorBox('FFmpeg selection failed', String(err.message));
    return null;
  } finally { selectingTools = false; }
}

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
    { label: 'Provider keys (inactive prototype)…', click: async () => {
      try {
        const keyWindow = await openKeyWindow(createStore(path.join(home, 'provider-keys.bin'), safeStorage));
        keyWindow.show();
      } catch { dialog.showErrorBox('Provider keys', 'The key window could not be opened.'); }
    } },
    { label: 'Configure local services…', click: configureServices },
    { label: 'Set up Piper voices…', click: selectPiper },
    { label: 'Select FFmpeg and ffprobe…', click: async () => {
      if (await selectTools()) await dialog.showMessageBox({ message: 'Tool locations saved. Quit and reopen Podcast Studio to use them.' });
    } },
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
    let tools = await readTools(home);
    if (!tools) {
      tools = await selectTools();
      if (!tools) { app.quit(); return; }
    }
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
    const piper = await readPiper(home);
    const services = await readServices(home);
    server = startServer(resources, home, () => error('The server stopped unexpectedly.'), { tools, piper, services });
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
