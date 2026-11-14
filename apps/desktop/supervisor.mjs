import path from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

export function childEnvironment(parent, resources, home) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (parent[key]) env[key] = parent[key];
  return { ...env, HOST: '127.0.0.1', PODCAST_STUDIO_RESOURCES: resources,
    PODCAST_STUDIO_HOME: home, DATA_DIR: path.join(home, 'data'),
    PODCAST_STUDIO_PARENT_STDIN: '1', PODCAST_STUDIO_DESKTOP_IPC: '1' };
}
export function validReady(message) {
  return message !== null && typeof message === 'object' && message.type === 'desktop-ready' &&
    Number.isInteger(message.port) && message.port > 0 && message.port <= 65535;
}
export function allowedExternal(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost') && !isIP(url.hostname.replace(/^\[|\]$/g, ''));
  } catch { return false; }
}
export function loginItem(app, refresh) {
  return { label: 'Start at login', type: 'checkbox', enabled: app.isPackaged,
    checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    click: (item) => {
      if (!app.isPackaged) return;
      app.setLoginItemSettings({ openAtLogin: item.checked });
      refresh();
    } };
}
export function startServer(resources, home, onExit) {
  const executable = path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const child = spawn(executable, [path.join(resources, 'server', 'server.mjs')], {
    env: childEnvironment(process.env, resources, home), cwd: home,
    stdio: ['pipe', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Server startup timed out')), 15000);
    function finish(error, port) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(port);
    }
    child.on('message', (message) => { if (validReady(message)) finish(null, message.port); });
    child.once('error', () => finish(new Error('Server could not start')));
    child.once('exit', (code) => { finish(new Error('Server exited during startup')); onExit(code); });
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 11000);
    await exited; clearTimeout(timeout);
    return child.exitCode === 0;
  }
  return { ready, stop };
}
