import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const KEY_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'TAVILY_API_KEY', 'BRAVE_API_KEY', 'AZURE_SPEECH_KEY', 'ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY',
]);

// Windows safeStorage uses DPAPI and does not protect against programs as the same user.
// https://www.electronjs.org/docs/latest/api/safe-storage#platform-specific-key-providers
export function createSecretsStore(file, safeStorage, platform = process.platform) {
  let pending = Promise.resolve();
  function serial(fn) {
    const next = pending.then(fn);
    pending = next.catch(() => {});
    return next;
  }
  async function load() {
    if (platform !== 'win32' || !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Secure storage unavailable');
    let blob;
    try { blob = await readFile(file); } catch (error) {
      if (error.code === 'ENOENT') return {};
      // Do not attach filesystem errors; they may include private paths.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Unable to read secure storage');
    }
    try {
      const { result } = await safeStorage.decryptStringAsync(blob);
      const value = JSON.parse(result);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value).some(([key, item]) => !KEY_NAMES.includes(key) || typeof item !== 'string' || !item.trim())) throw new Error();
      return value;
    } catch { throw new Error('Secure storage is corrupt or inaccessible'); }
  }
  async function save(values) {
    let tmp;
    try {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(values));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error();
      tmp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
      await writeFile(tmp, encrypted, { flag: 'wx', mode: 0o600 });
      await rename(tmp, file);
    } catch { throw new Error('Unable to update secure storage'); }
    finally { if (tmp) await unlink(tmp).catch(() => {}); }
  }
  function validName(name) {
    if (typeof name !== 'string' || !KEY_NAMES.includes(name)) throw new Error('Unknown key');
  }
  return {
    list: () => serial(async () => {
      const values = await load();
      return Object.fromEntries(KEY_NAMES.map((name) => [name, Object.hasOwn(values, name)]));
    }),
    set: (name, value) => serial(async () => {
      validName(name);
      if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) throw new Error('Invalid key');
      const values = await load(); values[name] = value;
      await save(values);
    }),
    clear: (name) => serial(async () => {
      validName(name);
      const values = await load(); delete values[name];
      await save(values);
    }),
    forChild: () => serial(load),
  };
}
