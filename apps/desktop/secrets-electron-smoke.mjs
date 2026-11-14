// Run explicitly with Electron; all values here are synthetic.
import { app, safeStorage } from 'electron';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSecretsStore } from './secrets.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'podcast-keys-smoke-'));
app.setPath('userData', home);
app.whenReady().then(async () => {
  const file = path.join(home, 'secrets.bin');
  const store = createSecretsStore(file, safeStorage);
  const value = 'synthetic-value-for-dpapi-smoke';
  await store.set('OPENAI_API_KEY', value);
  if ((await readFile(file)).includes(Buffer.from(value))) throw new Error('plaintext on disk');
  if (!(await store.list()).OPENAI_API_KEY || (await store.forChild()).OPENAI_API_KEY !== value) throw new Error('roundtrip failed');
  await store.clear('OPENAI_API_KEY');
  if ((await store.list()).OPENAI_API_KEY) throw new Error('clear failed');
  console.log('Windows safeStorage roundtrip passed');
  app.exit(0);
}).catch(() => { console.error('Windows safeStorage roundtrip failed'); app.exit(1); });
