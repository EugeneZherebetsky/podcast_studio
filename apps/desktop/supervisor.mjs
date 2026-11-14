import path from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

export function childEnvironment(parent, resources, home, tools) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (parent[key]) env[key] = parent[key];
  return { ...env, HOST: '127.0.0.1', PROFILE: 'local', SEARCH_PROVIDER: 'searxng', TTS_PROVIDER: 'piper', PODCAST_STUDIO_RESOURCES: resources,
    PODCAST_STUDIO_HOME: home, DATA_DIR: path.join(home, 'data'),
    ...(tools ? { FFMPEG_PATH: tools.ffmpeg, FFPROBE_PATH: tools.ffprobe } : {}),
    PODCAST_STUDIO_PARENT_STDIN: '1', PODCAST_STUDIO_DESKTOP_IPC: '1' };
}
export function validReady(message) {
  return message !== null && typeof message === 'object' && message.type === 'desktop-ready' &&
    Number.isInteger(message.port) && message.port > 0 && message.port <= 65535;
}
export function allowedExternal(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.+$/, '');
    return url.protocol === 'https:' && !url.username && !url.password &&
      hostname !== 'localhost' && !hostname.endsWith('.localhost') && !isIP(hostname.replace(/^\[|\]$/g, ''));
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
export function startServer(resources, home, onExit, options = {}) {
  const executable = path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const child = (options.spawn ?? spawn)(executable, [path.join(resources, 'server', 'server.mjs')], {
    env: childEnvironment(process.env, resources, home, options.tools), cwd: home,
    stdio: ['pipe', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  let state = 'starting';
  let exited = false;
  let spawnFailed = false;
  let stopPromise;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    exit.then(() => { clearTimeout(timer); resolve(true); });
  });
  let rejectReady;
  let resolveReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => fail('Server startup timed out'), options.startupMs ?? 15000);
  async function fail(message) {
    if (state !== 'starting') return;
    state = 'failed'; clearTimeout(timer);
    const clean = await stop();
    rejectReady(new Error(clean || exited || spawnFailed ? message : `${message}. Server termination could not be confirmed; it may still be running`));
  }
  child.on('message', (message) => {
    if (state !== 'starting' || !validReady(message)) return;
    state = 'ready'; clearTimeout(timer); resolveReady(message.port);
  });
  child.on('error', () => {
    if (!child.pid) { spawnFailed = true; resolveExit(); }
    void fail('Server could not start');
  });
  child.stdin?.on?.('error', () => {});
  child.once('exit', (code) => {
    exited = true; resolveExit();
    if (state === 'starting') void fail('Server exited during startup');
    else if (state === 'ready') { state = 'exited'; onExit(code); }
  });
  function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'starting') { void fail('Server startup cancelled'); return stopPromise; }
    if (state === 'ready') state = 'stopping';
    stopPromise = (async () => {
      if (exited || spawnFailed) return exited && child.exitCode === 0;
      try { child.stdin?.end(); } catch { /* still attempt termination */ }
      if (await wait(options.shutdownMs ?? 11000)) return exited && child.exitCode === 0;
      try { child.kill(); } catch { /* report failure if exit is not observed */ }
      if (!(await wait(options.postKillMs ?? 2000))) return false;
      return exited && child.exitCode === 0;
    })();
    return stopPromise;
  }
  return { ready, stop, terminationConfirmed: () => exited || spawnFailed };
}
