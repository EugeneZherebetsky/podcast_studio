import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { childEnvironment, validReady, allowedExternal, startServer, loginItem } from './supervisor.mjs';

test('constructs a minimal loopback child environment with shutdown opt-in', () => {
  const env = childEnvironment({ SystemRoot: 'system', PATH: 'path', API_KEY: 'do-not-copy' }, 'resources', 'home');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PROFILE, 'local');
  assert.equal(env.SEARCH_PROVIDER, 'searxng');
  assert.equal(env.TTS_PROVIDER, 'piper');
  assert.equal(env.PODCAST_STUDIO_PARENT_STDIN, '1');
  assert.equal(env.PODCAST_STUDIO_DESKTOP_IPC, '1');
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.SystemRoot, 'system');
});

test('passes only selected Piper settings to the next child', () => {
  const piper = { PIPER_DIR: 'home', TTS_VOICE_NATIVE_HOST: 'en_US-voice', TTS_VOICE_HU_HOST: 'hu_HU-voice', API_KEY: 'ignored' };
  const env = childEnvironment({}, 'resources', 'home', null, piper);
  assert.equal(env.PIPER_DIR, piper.PIPER_DIR);
  assert.equal(env.TTS_VOICE_NATIVE_HOST, piper.TTS_VOICE_NATIVE_HOST);
  assert.equal(env.TTS_VOICE_HU_HOST, piper.TTS_VOICE_HU_HOST);
  assert.equal(env.PODCAST_STUDIO_NATIVE_PIPER, '1');
  assert.equal(childEnvironment({ PODCAST_STUDIO_NATIVE_PIPER: '1' }, 'resources', 'home').PODCAST_STUDIO_NATIVE_PIPER, undefined);
  assert.equal(env.API_KEY, undefined);
});

test('passes explicitly selected local services to both model slots', () => {
  const services = { ollama: 'http://127.0.0.1:11434/v1', model: 'test:4b', searxng: 'http://[::1]:8888', API_KEY: 'ignored' };
  const env = childEnvironment({}, 'resources', 'home', null, null, services);
  assert.equal(env.OLLAMA_BASE_URL, services.ollama);
  assert.equal(env.OLLAMA_MODEL_MAIN, services.model);
  assert.equal(env.OLLAMA_MODEL_FAST, services.model);
  assert.equal(env.SEARXNG_URL, services.searxng);
  assert.equal(env.API_KEY, undefined);
});

test('readiness requires the exact child IPC message and a valid port', () => {
  assert.equal(validReady({ type: 'desktop-ready', port: 34567 }), true);
  for (const value of [null, {}, { type: 'desktop-ready', port: 0 }, { type: 'desktop-ready', port: '34567' }, { type: 'other', port: 34567 }]) assert.equal(validReady(value), false);
});

test('only public https links are eligible for system browser', () => {
  assert.equal(allowedExternal('https://example.org/path'), true);
  for (const url of ['file:///a', 'javascript:alert(1)', 'http://127.0.0.1:12/', 'https://localhost/', 'https://localhost./', 'https://foo.localhost./', 'https://user:password@example.com/']) assert.equal(allowedExternal(url), false, url);
});

test('login startup is not enabled implicitly and changes only on explicit click', () => {
  const writes = [];
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: (value) => writes.push(value) };
  const item = loginItem(app, () => {});
  assert.equal(item.checked, false);
  assert.deepEqual(writes, []);
  item.click({ checked: true });
  assert.deepEqual(writes, [{ openAtLogin: true }]);
  assert.equal(loginItem({ ...app, isPackaged: false }, () => {}).enabled, false);
});

test('timeout shuts down the child and rejects late readiness', { timeout: 1000 }, async () => {
  const process = new EventEmitter();
  process.exitCode = null; process.signalCode = null;
  let ended = false; let exits = 0;
  process.stdin = { end() { ended = true; process.emit('message', { type: 'desktop-ready', port: 1234 }); process.exitCode = 0; process.emit('exit', 0); } };
  process.kill = () => { throw new Error('unexpected kill'); };
  const server = startServer('resources', '.', () => { exits++; }, { spawn: () => process, startupMs: 10, shutdownMs: 10, postKillMs: 10 });
  await assert.rejects(server.ready, /startup timed out/);
  assert.equal(ended, true);
  assert.equal(exits, 0);
});

test('timeout terminates a real child before late readiness', { timeout: 3000 }, async () => {
  let child;
  let opened = false;
  const server = startServer('.', '.', () => {}, { startupMs: 150, shutdownMs: 500, postKillMs: 500,
    spawn: () => {
      child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.send({type:'desktop-ready',port:1234}), 1000)"], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
      return child;
    } });
  const exit = once(child, 'exit');
  try {
    await server.ready.then(() => { opened = true; }, (error) => { assert.match(error.message, /startup timed out/); });
    await exit;
    assert.equal(opened, false);
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('quit during startup cancels readiness and closes the child once', { timeout: 1000 }, async () => {
  const child = new EventEmitter();
  child.pid = 42; child.exitCode = null; child.signalCode = null;
  let ends = 0;
  child.stdin = { end() { ends++; child.emit('message', { type: 'desktop-ready', port: 1234 }); child.exitCode = 0; child.emit('exit', 0); } };
  const server = startServer('.', '.', () => assert.fail('unexpected exit'), { spawn: () => child, startupMs: 500, shutdownMs: 10, postKillMs: 10 });
  const rejected = assert.rejects(server.ready, /startup cancelled/);
  assert.equal(await server.stop(), true);
  await rejected;
  assert.equal(ends, 1);
});

test('failed kill and missing exit are bounded and reported', { timeout: 1000 }, async () => {
  for (const kill of [() => false, () => true, () => { throw new Error('denied'); }]) {
    const child = new EventEmitter();
    child.pid = 42; child.exitCode = null; child.signalCode = null;
    child.stdin = { end() {} }; child.kill = kill;
    const server = startServer('.', '.', () => {}, { spawn: () => child, startupMs: 5, shutdownMs: 5, postKillMs: 5 });
    await assert.rejects(server.ready, /termination could not be confirmed/);
    assert.equal(await server.stop(), false);
    child.emit('message', { type: 'desktop-ready', port: 1234 });
  }
});

test('missing executable fails promptly and remains safe to stop', { timeout: 1000 }, async () => {
  const child = startServer('nonexistent-resources', process.cwd(), () => {});
  await assert.rejects(child.ready, /could not start/);
  await child.stop();
});
