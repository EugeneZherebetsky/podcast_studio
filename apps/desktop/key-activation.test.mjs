import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createKeyReader, createStore, KEY_NAMES } from './write-only-store.mjs';
import { USABLE_KEY_NAMES, launchKeys, launchMessage, readActivation, saveActivation } from './key-activation.mjs';
import { keyChannels } from './key-ipc.mjs';
import { childEnvironment, startServer } from './supervisor.mjs';

// Obviously fake values: none of these is, or resembles, a real credential.
const FAKE = Object.freeze({
  ELEVENLABS_API_KEY: 'synthetic-elevenlabs-key-0001',
  FISH_AUDIO_API_KEY: 'synthetic-fish-key-0002',
  OPENAI_API_KEY: 'synthetic-openai-key-0003',
  ANTHROPIC_API_KEY: 'synthetic-anthropic-key-0004',
});
const hostile = Object.freeze({
  SystemRoot: 'system', PATH: 'path', OPENAI_API_KEY: 'synthetic-parent-openai', ELEVENLABS_API_KEY: 'synthetic-parent-elevenlabs',
  FISH_AUDIO_API_KEY: 'synthetic-parent-fish', ANTHROPIC_BASE_URL: 'https://redirect.invalid', OPENAI_BASE_URL: 'https://redirect.invalid',
  HTTPS_PROXY: 'http://proxy.invalid', NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: '--require=x', NODE_EXTRA_CA_CERTS: 'ca.pem',
  NODE_TLS_REJECT_UNAUTHORIZED: '0', PROFILE: 'cloud', TTS_PROVIDER: 'openai', SEARCH_PROVIDER: 'tavily', AZURE_SPEECH_REGION: 'redirect.invalid/#',
});
const BASE = ['DATA_DIR', 'HOST', 'PATH', 'PODCAST_STUDIO_DESKTOP_IPC', 'PODCAST_STUDIO_HOME', 'PODCAST_STUDIO_PARENT_STDIN', 'PODCAST_STUDIO_RESOURCES', 'PROFILE', 'SEARCH_PROVIDER', 'SystemRoot', 'TTS_PROVIDER'];

function cryptoStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptStringAsync: async (blob) => { const c = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); c.setAuthTag(blob.subarray(12, 28)); return { result: Buffer.concat([c.update(blob.subarray(28)), c.final()]).toString() }; },
  };
}
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'key-activation-'));
  try {
    const file = path.join(dir, 'keys.bin');
    const crypto = cryptoStorage();
    const store = createStore(file, crypto, { platform: 'win32' });
    for (const [name, value] of Object.entries(FAKE)) await store.set(name, value);
    await fn({ dir, file, crypto, store, reader: createKeyReader(file, crypto, { platform: 'win32' }) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const countingReader = (reader) => { const counted = { calls: 0, read: (names) => { counted.calls++; return reader.read(names); } }; return counted; };

test('only keys the desktop child can use are eligible, and all are allowlisted', () => {
  assert.deepEqual([...USABLE_KEY_NAMES], ['ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY']);
  for (const name of USABLE_KEY_NAMES) assert.equal(KEY_NAMES.includes(name), true);
});

test('stored values stay inactive after an upgrade: no file means off and the store is not opened', () => fixture(async ({ dir, reader }) => {
  const counted = countingReader(reader);
  assert.deepEqual(await readActivation(dir), { enabled: false, keys: [] });
  assert.deepEqual(await launchKeys(dir, counted), { state: 'off', keys: {}, names: [] });
  assert.equal(counted.calls, 0);
  const env = childEnvironment(hostile, 'resources', 'home', null, null, null, (await launchKeys(dir, counted)).keys);
  assert.deepEqual(Object.keys(env).sort(), BASE);
  for (const name of KEY_NAMES) assert.equal(Object.hasOwn(env, name), false, name);
  assert.equal(launchMessage('off'), null);
}));

test('ticked keys without the master switch, and the switch without ticked keys, stay off', () => fixture(async ({ dir, reader }) => {
  const counted = countingReader(reader);
  await saveActivation(dir, { enabled: false, keys: ['ELEVENLABS_API_KEY'] });
  assert.deepEqual((await launchKeys(dir, counted)).keys, {});
  await saveActivation(dir, { enabled: true, keys: [] });
  assert.deepEqual((await launchKeys(dir, counted)).keys, {});
  assert.equal(counted.calls, 0);
}));

test('activation on passes only the ticked usable key and nothing from the parent environment', () => fixture(async ({ dir, reader }) => {
  await saveActivation(dir, { enabled: true, keys: ['ELEVENLABS_API_KEY'] });
  const launch = await launchKeys(dir, reader);
  assert.deepEqual(launch, { state: 'on', keys: { ELEVENLABS_API_KEY: FAKE.ELEVENLABS_API_KEY }, names: ['ELEVENLABS_API_KEY'] });
  const env = childEnvironment(hostile, 'resources', 'home', null, null, null, launch.keys);
  assert.deepEqual(Object.keys(env).sort(), [...BASE, 'ELEVENLABS_API_KEY'].sort());
  assert.equal(env.ELEVENLABS_API_KEY, FAKE.ELEVENLABS_API_KEY);
  assert.equal(env.PROFILE, 'local'); assert.equal(env.SEARCH_PROVIDER, 'searxng'); assert.equal(env.TTS_PROVIDER, 'piper');
  const text = JSON.stringify(env);
  for (const value of Object.values(hostile).filter((item) => /synthetic|invalid/.test(item))) assert.equal(text.includes(value), false, value);
  for (const name of ['FISH_AUDIO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(text.includes(FAKE[name]), false, name);
}));

test('the child environment drops non-usable or forged entries even if a caller supplies them', () => {
  const env = childEnvironment({}, 'resources', 'home', null, null, null, { ...FAKE, PROFILE: 'cloud', HOST: '0.0.0.0', TTS_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://redirect.invalid', FISH_AUDIO_API_KEY: 7 });
  assert.equal(env.ELEVENLABS_API_KEY, FAKE.ELEVENLABS_API_KEY);
  for (const name of ['FISH_AUDIO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']) assert.equal(Object.hasOwn(env, name), false, name);
  assert.equal(env.PROFILE, 'local'); assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.TTS_PROVIDER, 'piper');
});

test('keys travel in the child environment only: never in arguments, and stdout and stderr stay discarded', () => {
  let call;
  const child = new EventEmitter(); child.stdin = { end() {}, on() {} }; child.kill = () => {}; child.pid = 1; child.exitCode = null;
  const server = startServer('resources', 'home', () => {}, { startupMs: 60000, keys: { FISH_AUDIO_API_KEY: FAKE.FISH_AUDIO_API_KEY }, spawn: (...args) => { call = args; return child; } });
  server.ready.catch(() => {});
  const [executable, argv, options] = call;
  assert.equal(JSON.stringify([executable, argv, options.cwd]).includes(FAKE.FISH_AUDIO_API_KEY), false);
  assert.equal(options.env.FISH_AUDIO_API_KEY, FAKE.FISH_AUDIO_API_KEY);
  assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore', 'ipc']);
  child.exitCode = 0; child.emit('exit', 0);
});

test('a corrupt store starts the app without keys and reports only a generic message', () => fixture(async ({ dir, file, reader }) => {
  await saveActivation(dir, { enabled: true, keys: [...USABLE_KEY_NAMES] });
  await writeFile(file, `corrupt ${FAKE.ELEVENLABS_API_KEY}`);
  const launch = await launchKeys(dir, reader);
  assert.deepEqual(launch, { state: 'failed', keys: {}, names: [] });
  const message = launchMessage(launch.state);
  assert.equal(message, 'Stored provider keys could not be read. Podcast Studio started without them.');
  assert.equal(Object.keys(childEnvironment({}, 'resources', 'home', null, null, null, launch.keys)).some((name) => KEY_NAMES.includes(name)), false);
}));

test('unavailable encryption and a throwing reader also fail closed without detail', () => fixture(async ({ dir, file, crypto }) => {
  await saveActivation(dir, { enabled: true, keys: [...USABLE_KEY_NAMES] });
  assert.equal((await launchKeys(dir, createKeyReader(file, crypto, { platform: 'linux' }))).state, 'failed');
  const launch = await launchKeys(dir, { read: async () => { throw new Error(FAKE.FISH_AUDIO_API_KEY); } });
  assert.deepEqual(launch, { state: 'failed', keys: {}, names: [] });
  assert.equal(JSON.stringify([launch, launchMessage(launch.state)]).includes(FAKE.FISH_AUDIO_API_KEY), false);
}));

test('a value that cannot travel safely in a header is withheld', () => fixture(async ({ dir, store, reader }) => {
  await store.set('FISH_AUDIO_API_KEY', 'synthetic fish\r\nX-Injected: 1');
  await saveActivation(dir, { enabled: true, keys: [...USABLE_KEY_NAMES] });
  const launch = await launchKeys(dir, reader);
  assert.equal(launch.state, 'partial');
  assert.deepEqual(launch.names, ['ELEVENLABS_API_KEY']);
  assert.equal(typeof launchMessage('partial'), 'string');
}));

test('an invalid activation file means off, and only usable names can be saved', () => fixture(async ({ dir, reader }) => {
  for (const text of ['{', '{"enabled":"yes","keys":[]}', '{"enabled":true,"keys":["OPENAI_API_KEY"]}', '{"enabled":true,"keys":"ELEVENLABS_API_KEY"}', '[]']) {
    await writeFile(path.join(dir, 'key-activation.json'), text);
    assert.deepEqual(await launchKeys(dir, reader), { state: 'off', keys: {}, names: [] }, text);
  }
  for (const value of [null, { enabled: true }, { enabled: 1, keys: [] }, { enabled: true, keys: ['OPENAI_API_KEY'] }, { enabled: true, keys: ['PROFILE'] }, { enabled: true, keys: ['FISH_AUDIO_API_KEY', 'FISH_AUDIO_API_KEY'] }])
    await assert.rejects(saveActivation(dir, value), /Invalid key activation settings/);
  await saveActivation(dir, { enabled: true, keys: ['FISH_AUDIO_API_KEY'], extra: FAKE.OPENAI_API_KEY });
  assert.equal(await readFile(path.join(dir, 'key-activation.json'), 'utf8'), '{"enabled":true,"keys":["FISH_AUDIO_API_KEY"]}');
}));

test('the reader is separate from the window store and returns only requested allowlisted names', () => fixture(async ({ store, reader }) => {
  assert.deepEqual(Object.keys(store).sort(), ['clear', 'list', 'set']);
  assert.deepEqual(Object.keys(reader), ['read']);
  assert.deepEqual(await reader.read(['FISH_AUDIO_API_KEY', 'BRAVE_API_KEY']), { FISH_AUDIO_API_KEY: FAKE.FISH_AUDIO_API_KEY });
  await assert.rejects(reader.read(['CHATGPT_SESSION_TOKEN']), /Unknown key/);
  await assert.rejects(reader.read('FISH_AUDIO_API_KEY'), /Unknown key/);
}));

test('the window channels expose presence, set, clear and the activation choice, and never a value', () => fixture(async ({ dir, store, reader }) => {
  // Even a store object that could read must not gain a channel.
  const channels = keyChannels({ ...store, read: reader.read }, {
    get: async () => ({ ...(await readActivation(dir)), usable: USABLE_KEY_NAMES, launch: { state: 'on', names: ['FISH_AUDIO_API_KEY'], keys: { ...FAKE } }, keys_values: { ...FAKE } }),
    set: (value) => saveActivation(dir, value),
  });
  assert.deepEqual(Object.keys(channels).sort(), ['keys:activate', 'keys:activation', 'keys:clear', 'keys:list', 'keys:set']);
  const replies = [
    await channels['keys:list'](), await channels['keys:list'](['FISH_AUDIO_API_KEY']), await channels['keys:activation'](),
    await channels['keys:activate']({ enabled: true, keys: ['FISH_AUDIO_API_KEY'] }), await channels['keys:activation'](),
    await channels['keys:set']('BRAVE_API_KEY', 'synthetic-brave-key-0005'), await channels['keys:clear']('BRAVE_API_KEY'),
    await channels['keys:set']('CHATGPT_SESSION_TOKEN', 'synthetic'), await channels['keys:activate']({ enabled: true, keys: ['OPENAI_API_KEY'] }),
    await channels['keys:activate'](null), await channels['keys:clear']({}),
  ];
  const text = JSON.stringify(replies);
  for (const value of [...Object.values(FAKE), 'synthetic-brave-key-0005']) assert.equal(text.includes(value), false);
  assert.deepEqual(replies[4], { ok: true, value: { enabled: true, keys: ['FISH_AUDIO_API_KEY'], usable: ['ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY'], launch: { state: 'on', names: ['FISH_AUDIO_API_KEY'] } } });
  assert.deepEqual(replies.slice(7), [{ ok: false }, { ok: false }, { ok: false }, { ok: false }]);
  assert.deepEqual(await readActivation(dir), { enabled: true, keys: ['FISH_AUDIO_API_KEY'] });
}));

test('the renderer bridge has no read call', async () => {
  const source = await readFile(new URL('./key-preload.cjs', import.meta.url), 'utf8');
  const invoked = []; let exposed;
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } }, ipcRenderer: { invoke: (...args) => { invoked.push(args); } } };
  new Function('require', source)((id) => { assert.equal(id, 'electron'); return electron; });
  assert.equal(exposed.name, 'keys');
  assert.deepEqual(Object.keys(exposed.api).sort(), ['activation', 'clear', 'list', 'set', 'setActivation']);
  for (const call of Object.values(exposed.api)) call('a', 'b');
  assert.deepEqual(invoked.map(([channel]) => channel).sort(), ['keys:activate', 'keys:activation', 'keys:clear', 'keys:list', 'keys:set']);
  assert.equal(/read|decrypt|get\b/i.test(source.replace(/require|ipcRenderer/g, '')), false);
});

test('the shell reads stored keys once at launch and gives the window no reader', async () => {
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.equal(main.match(/createKeyReader\(/g).length, 1);
  assert.equal(main.match(/launchKeys\(/g).length, 1);
  assert.equal(main.match(/startServer\(/g).length, 1);
  assert.equal(/inactive prototype/i.test(main), false);
  const win = await readFile(new URL('./key-window.mjs', import.meta.url), 'utf8');
  assert.equal(/createKeyReader|startServer|supervisor/.test(win + await readFile(new URL('./key-ipc.mjs', import.meta.url), 'utf8')), false);
});
