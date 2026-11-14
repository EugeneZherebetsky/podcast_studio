import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createStore } from './write-only-store.mjs';

function cryptoStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptStringAsync: async (blob) => { const c = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); c.setAuthTag(blob.subarray(12, 28)); return { result: Buffer.concat([c.update(blob.subarray(28)), c.final()]).toString() }; },
  };
}
async function fixture(fn) { const dir = await mkdtemp(path.join(tmpdir(), 'write-only-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test('write only: encrypted persistence, allowlist, status and clear', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin'); const store = createStore(file, cryptoStorage(), { platform: 'win32' });
  assert.deepEqual(Object.keys(store).sort(), ['clear', 'list', 'set']);
  await store.set('OPENAI_API_KEY', 'synthetic-example');
  assert.equal((await readFile(file)).includes(Buffer.from('synthetic-example')), false);
  assert.equal((await store.list()).OPENAI_API_KEY, true);
  await assert.rejects(store.set('CHATGPT_SESSION_TOKEN', 'synthetic'), /Unknown key/);
  await store.clear('OPENAI_API_KEY'); assert.equal((await store.list()).OPENAI_API_KEY, false);
}));

test('corruption and unavailable encryption fail closed without overwriting', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin'); await writeFile(file, 'corrupt');
  const store = createStore(file, cryptoStorage(), { platform: 'win32' });
  await assert.rejects(store.set('OPENAI_API_KEY', 'synthetic'), /corrupt/);
  assert.equal(await readFile(file, 'utf8'), 'corrupt');
  await assert.rejects(createStore(file, cryptoStorage(), { platform: 'linux' }).list(), /unavailable/);
}));

test('failed rename preserves original', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin'); const crypto = cryptoStorage();
  const store = createStore(file, crypto, { platform: 'win32' }); await store.set('OPENAI_API_KEY', 'synthetic-first');
  const before = await readFile(file);
  const failing = createStore(file, crypto, { platform: 'win32', rename: async () => { throw new Error('private'); } });
  await assert.rejects(failing.set('BRAVE_API_KEY', 'synthetic-second'), /Unable to update/);
  assert.deepEqual(await readFile(file), before);
}));

test('concurrent stores do not lose an update', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin'); const crypto = cryptoStorage();
  const a = createStore(file, crypto, { platform: 'win32' }); const b = createStore(file, crypto, { platform: 'win32' });
  await Promise.all([a.set('OPENAI_API_KEY', 'synthetic-one'), b.set('BRAVE_API_KEY', 'synthetic-two')]);
  const result = await a.list(); assert.equal(result.OPENAI_API_KEY, true); assert.equal(result.BRAVE_API_KEY, true);
}));

test('partial write failure preserves the prior file', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin'); const crypto = cryptoStorage();
  const store = createStore(file, crypto, { platform: 'win32' }); await store.set('OPENAI_API_KEY', 'synthetic-first');
  const before = await readFile(file);
  const failingOpen = async (...args) => {
    const handle = await open(...args);
    return { writeFile: async (bytes) => { await handle.writeFile(bytes.subarray(0, 3)); throw new Error(); }, close: () => handle.close() };
  };
  const failing = createStore(file, crypto, { platform: 'win32', open: failingOpen });
  await assert.rejects(failing.set('BRAVE_API_KEY', 'synthetic-second'), /Unable to update/);
  assert.deepEqual(await readFile(file), before);
}));

test('separate processes serialize updates through the same lock', () => fixture(async (dir) => {
  const file = path.join(dir, 'keys.bin');
  const moduleUrl = new URL('./write-only-store.mjs', import.meta.url).href;
  const code = `import { createStore } from ${JSON.stringify(moduleUrl)};
    const crypto = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async s => { await new Promise(r => setTimeout(r, 60)); return Buffer.from(s); }, decryptStringAsync: async b => ({ result: b.toString() }) };
    await createStore(process.argv[1], crypto, {platform:'win32'}).set(process.argv[2], 'synthetic');`;
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, name], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(`child failed: ${status}`)));
  });
  await Promise.all([run('OPENAI_API_KEY'), run('BRAVE_API_KEY')]);
  const values = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(values).sort(), ['BRAVE_API_KEY', 'OPENAI_API_KEY']);
}));

test('refuses a junction in the parent path', () => fixture(async (dir) => {
  const alias = path.join(dir, 'alias');
  await symlink(dir, alias, 'junction');
  const store = createStore(path.join(alias, 'keys.bin'), cryptoStorage(), { platform: 'win32' });
  await assert.rejects(store.set('OPENAI_API_KEY', 'synthetic'), /Unsafe storage path/);
}));

test('refuses symlink target without changing it', (t) => fixture(async (dir) => {
  const target = path.join(dir, 'target'); const file = path.join(dir, 'keys.bin'); await writeFile(target, 'untouched');
  try { await symlink(target, file, 'file'); } catch (error) { if (error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; } throw error; }
  const store = createStore(file, cryptoStorage(), { platform: 'win32' });
  await assert.rejects(store.set('OPENAI_API_KEY', 'synthetic'));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
}));
