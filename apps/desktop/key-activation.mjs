import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { KEY_NAMES } from './write-only-store.mjs';

// The desktop child always runs the local generation profile. Its runner has exactly one
// keyed cloud path: cloud speech (ElevenLabs or Fish Audio) chosen in the web Settings and
// saved in the child's database. No other stored key can be used by the child, so no other
// key is ever handed to it.
export const USABLE_KEY_NAMES = Object.freeze(['ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY'].filter((name) => KEY_NAMES.includes(name)));

const FILE = 'key-activation.json';
// Printable ASCII without spaces: safe as an environment value and as an HTTP header value.
const TRANSPORTABLE = /^[\x21-\x7e]{1,8192}$/;

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.keys) ||
    value.keys.some((name) => !USABLE_KEY_NAMES.includes(name)) || new Set(value.keys).size !== value.keys.length) throw new Error('Invalid key activation settings');
  return { enabled: value.enabled, keys: USABLE_KEY_NAMES.filter((name) => value.keys.includes(name)) };
}

/** Off unless a valid file says otherwise: a missing, unreadable or invalid file means off. */
export async function readActivation(home) {
  try { return validate(JSON.parse(await readFile(path.join(home, FILE), 'utf8'))); }
  catch { return { enabled: false, keys: [] }; }
}

export async function saveActivation(home, value) {
  const valid = validate(value);
  const target = path.join(home, FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(valid), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * Decides once, at launch, which stored keys the child receives. The store is not opened
 * at all unless the user switched activation on and ticked at least one key. Never throws:
 * any failure starts the app without keys and reports only a state name.
 */
export async function launchKeys(home, reader) {
  const activation = await readActivation(home);
  if (!activation.enabled || activation.keys.length === 0) return { state: 'off', keys: {}, names: [] };
  try {
    const stored = await reader.read(activation.keys);
    const keys = {};
    let skipped = false;
    for (const name of activation.keys) {
      if (!Object.hasOwn(stored, name)) continue;
      if (typeof stored[name] === 'string' && TRANSPORTABLE.test(stored[name])) keys[name] = stored[name];
      else skipped = true;
    }
    return { state: skipped ? 'partial' : 'on', keys, names: Object.keys(keys) };
  } catch { return { state: 'failed', keys: {}, names: [] }; }
}

const MESSAGES = Object.freeze({
  failed: 'Stored provider keys could not be read. Podcast Studio started without them.',
  partial: 'A stored provider key has an unsupported format and was not used.',
});
/** A fixed sentence for states the user should hear about; never derived from stored data. */
export function launchMessage(state) { return Object.hasOwn(MESSAGES, state) ? MESSAGES[state] : null; }
