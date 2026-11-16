import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('missing FFmpeg does not block desktop startup and native chooser remains available', async () => {
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /Select FFmpeg and ffprobe/);
  assert.match(main, /const tools = await readTools\(home\)/);
  assert.doesNotMatch(main, /if \(!tools\) \{ app\.quit\(\); return; \}/);
});
