import { KEY_NAMES } from './write-only-store.mjs';

const STATES = ['off', 'on', 'partial', 'failed'];
const names = (value) => KEY_NAMES.filter((name) => Array.isArray(value) && value.includes(name));

/**
 * Everything the key window can ask for. There is deliberately no channel that returns a
 * stored value: replies carry presence, the activation choice and key names only, and every
 * failure collapses to `{ ok: false }` so no error text crosses the bridge.
 */
export function keyChannels(store, activation) {
  const channels = {
    'keys:list': async () => {
      const present = await store.list();
      return { ok: true, value: Object.fromEntries(KEY_NAMES.map((name) => [name, present[name] === true])) };
    },
    'keys:set': async (name, value) => { await store.set(name, value); return { ok: true }; },
    'keys:clear': async (name) => { await store.clear(name); return { ok: true }; },
    'keys:activation': async () => {
      const current = await activation.get();
      return { ok: true, value: { enabled: current.enabled === true, keys: names(current.keys), usable: names(current.usable),
        launch: { state: STATES.includes(current.launch?.state) ? current.launch.state : 'off', names: names(current.launch?.names) } } };
    },
    'keys:activate': async (value) => { await activation.set({ enabled: value?.enabled, keys: value?.keys }); return { ok: true }; },
  };
  return Object.freeze(Object.fromEntries(Object.entries(channels).map(([channel, action]) => [channel, async (...args) => {
    try { return await action(...args); } catch { return { ok: false }; }
  }])));
}
