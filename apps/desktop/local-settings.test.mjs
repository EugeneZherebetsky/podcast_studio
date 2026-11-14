import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savePiper, readPiper, saveServices, readServices } from './local-settings.mjs';

test('service settings validate loopback and preserve previous settings on failure', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'podcast-services-'));
  const good = { ollama: 'http://localhost:11434/v1', model: 'qwen3.5:4b', searxng: 'http://[::1]:8888' };
  try {
    await saveServices(home, good);
    assert.deepEqual(await readServices(home), good);
    for (const url of ['http://user:pass@localhost/v1', 'http://192.168.1.1', 'http://example.com', 'http://127.1', 'http://localhost.evil', 'http://127.0.0.1/#x', 'http://localhost?x', 'http://127.0.0.1:99999']) {
      await assert.rejects(saveServices(home, { ...good, ollama: url }));
      await assert.rejects(saveServices(home, { ...good, searxng: url }));
    }
    for (const model of ['', 'bad name', 'name:cloud', 'cloud', 'x\nmodel', '../bad', 'x'.repeat(257)]) await assert.rejects(saveServices(home, { ...good, model }));
    assert.deepEqual(await readServices(home), good);
    const ipv4 = { ...good, ollama: 'http://127.0.0.1:11434/v1' };
    await saveServices(home, ipv4);
    assert.deepEqual(await readServices(home), ipv4);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('failed publication preserves existing settings target', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'podcast-services-failure-'));
  try {
    const target = path.join(home, 'service-settings.json');
    await mkdir(target);
    await writeFile(path.join(target, 'keep'), 'untouched');
    await assert.rejects(saveServices(home, { ollama: 'http://localhost:11434/v1', model: 'qwen:4b', searxng: 'http://127.0.0.1:8888' }));
    assert.equal(await readFile(path.join(target, 'keep'), 'utf8'), 'untouched');
    assert.deepEqual((await readdir(home)).sort(), ['service-settings.json']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('saves a Piper home and matching voice pairs without executing them', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'podcast-piper-'));
  try {
    const piper = path.join(home, 'piper');
    const exe = path.join(piper, 'venv', process.platform === 'win32' ? 'Scripts/piper.exe' : 'bin/piper');
    await mkdir(path.dirname(exe), { recursive: true });
    await mkdir(path.join(piper, 'voices'));
    await writeFile(exe, 'not executable');
    for (const voice of ['en_US-test-medium', 'hu_HU-test-medium']) for (const suffix of ['.onnx', '.onnx.json']) await writeFile(path.join(piper, 'voices', voice + suffix), 'fixture');
    await savePiper(home, { executable: exe, native: path.join(piper, 'voices', 'en_US-test-medium.onnx'), hu: path.join(piper, 'voices', 'hu_HU-test-medium.onnx') });
    assert.deepEqual(await readPiper(home), { PIPER_DIR: piper, TTS_VOICE_NATIVE_HOST: 'en_US-test-medium', TTS_VOICE_HU_HOST: 'hu_HU-test-medium' });
    await assert.rejects(savePiper(home, { executable: exe, native: path.join(piper, 'voices', 'en_US-missing.onnx'), hu: path.join(piper, 'voices', 'hu_HU-test-medium.onnx') }));
    assert.equal((await readPiper(home)).TTS_VOICE_NATIVE_HOST, 'en_US-test-medium');
  } finally { await rm(home, { recursive: true, force: true }); }
});
