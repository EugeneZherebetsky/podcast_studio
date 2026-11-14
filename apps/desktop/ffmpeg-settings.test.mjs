import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readTools, saveTools } from './ffmpeg-settings.mjs';
import { childEnvironment } from './supervisor.mjs';

test('persists only explicit tool paths atomically and passes them to the isolated child', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'podcast-tools-'));
  try {
    const ffmpeg = path.join(home, 'ffmpeg.exe');
    const ffprobe = path.join(home, 'ffprobe.exe');
    await writeFile(ffmpeg, 'fake'); await writeFile(ffprobe, 'fake');
    const tools = { ffmpeg, ffprobe, secret: 'must-not-persist' };
    await saveTools(home, tools);
    assert.deepEqual(await readTools(home), { ffmpeg, ffprobe });
    assert.equal((await readFile(path.join(home, 'ffmpeg-settings.json'), 'utf8')).includes('must-not-persist'), false);
    const env = childEnvironment({ API_KEY: 'private', FFMPEG_PATH: 'injected' }, 'resources', home, tools);
    assert.equal(env.FFMPEG_PATH, ffmpeg); assert.equal(env.FFPROBE_PATH, ffprobe);
    assert.equal(env.API_KEY, undefined);
    await assert.rejects(saveTools(home, { ffmpeg: 'relative.exe', ffprobe }));
    assert.deepEqual(await readTools(home), { ffmpeg, ffprobe });
    await saveTools(home, { ffmpeg, ffprobe });
    assert.deepEqual(await readTools(home), { ffmpeg, ffprobe });
    await rm(ffprobe);
    assert.equal(await readTools(home), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});
