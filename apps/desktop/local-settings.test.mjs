import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savePiper, readPiper } from './local-settings.mjs';

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
