import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnvironment, validReady, allowedExternal, startServer, loginItem } from './supervisor.mjs';

test('constructs a minimal loopback child environment with shutdown opt-in', () => {
  const env = childEnvironment({ SystemRoot: 'system', PATH: 'path', API_KEY: 'do-not-copy' }, 'resources', 'home');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PODCAST_STUDIO_PARENT_STDIN, '1');
  assert.equal(env.PODCAST_STUDIO_DESKTOP_IPC, '1');
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.SystemRoot, 'system');
});

test('readiness requires the exact child IPC message and a valid port', () => {
  assert.equal(validReady({ type: 'desktop-ready', port: 34567 }), true);
  for (const value of [null, {}, { type: 'desktop-ready', port: 0 }, { type: 'desktop-ready', port: '34567' }, { type: 'other', port: 34567 }]) assert.equal(validReady(value), false);
});

test('only public https links are eligible for system browser', () => {
  assert.equal(allowedExternal('https://example.org/path'), true);
  for (const url of ['file:///a', 'javascript:alert(1)', 'http://127.0.0.1:12/', 'https://localhost/', 'https://user:password@example.com/']) assert.equal(allowedExternal(url), false);
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

test('missing executable fails promptly and remains safe to stop', { timeout: 1000 }, async () => {
  const child = startServer('nonexistent-resources', process.cwd(), () => {});
  await assert.rejects(child.ready, /could not start/);
  await child.stop();
});
