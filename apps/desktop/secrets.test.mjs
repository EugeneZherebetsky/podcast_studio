import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecretsStore } from './secrets.mjs';

function cryptoStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => {
      const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]);
    },
    decryptStringAsync: async (blob) => {
      const c = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      c.setAuthTag(blob.subarray(12, 28));
      return { result: Buffer.concat([c.update(blob.subarray(28)), c.final()]).toString(), shouldReEncrypt: false };
    },
  };
}

test('stores a key encrypted and reports status without exposing its value', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'keys-test-'));
  try {
    const file = path.join(dir, 'secrets.bin');
    const store = createSecretsStore(file, cryptoStorage(), 'win32');
    await store.set('OPENAI_API_KEY', 'synthetic-private-value');
    assert.equal((await readFile(file)).includes(Buffer.from('synthetic-private-value')), false);
    const statuses = await store.list();
    assert.equal(statuses.OPENAI_API_KEY, true);
    assert.equal(JSON.stringify(statuses).includes('synthetic-private-value'), false);
    assert.deepEqual(await store.forChild(), { OPENAI_API_KEY: 'synthetic-private-value' });
    await store.clear('OPENAI_API_KEY');
    assert.equal((await store.list()).OPENAI_API_KEY, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fails closed for unsupported platforms, unavailable encryption and corrupt files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'keys-test-'));
  try {
    const file = path.join(dir, 'secrets.bin');
    const storage = cryptoStorage();
    await assert.rejects(createSecretsStore(file, storage, 'linux').list(), /unavailable/);
    await assert.rejects(createSecretsStore(file, { ...storage, isAsyncEncryptionAvailable: async () => false }, 'win32').set('OPENAI_API_KEY', 'sample'), /unavailable/);
    await writeFile(file, 'corrupted');
    const store = createSecretsStore(file, storage, 'win32');
    await assert.rejects(store.set('OPENAI_API_KEY', 'sample'), /corrupt or inaccessible/);
    assert.equal(await readFile(file, 'utf8'), 'corrupted');
    await assert.rejects(store.set('CHATGPT_SESSION_TOKEN', 'sample'), /Unknown key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed encryption preserves previously encrypted data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'keys-test-'));
  try {
    const file = path.join(dir, 'secrets.bin');
    const storage = cryptoStorage();
    const store = createSecretsStore(file, storage, 'win32');
    await store.set('OPENAI_API_KEY', 'first-synthetic');
    const before = await readFile(file);
    storage.encryptStringAsync = async () => { throw new Error('sensitive error'); };
    await assert.rejects(store.set('OPENAI_API_KEY', 'second-synthetic'), /^Error: Unable to update secure storage$/);
    assert.deepEqual(await readFile(file), before);
    assert.equal((await store.forChild()).OPENAI_API_KEY, 'first-synthetic');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent updates do not overwrite each other', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'keys-test-'));
  try {
    const store = createSecretsStore(path.join(dir, 'secrets.bin'), cryptoStorage(), 'win32');
    await Promise.all([store.set('OPENAI_API_KEY', 'first'), store.set('BRAVE_API_KEY', 'second')]);
    assert.deepEqual(await store.forChild(), { OPENAI_API_KEY: 'first', BRAVE_API_KEY: 'second' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
