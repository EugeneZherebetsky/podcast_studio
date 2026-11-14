import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const KEY_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'TAVILY_API_KEY',
  'BRAVE_API_KEY', 'AZURE_SPEECH_KEY', 'ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY',
]);

// A cooperative lock prevents lost updates across processes; a crash requires manual recovery.
// Same-user adversarial filesystem races are not excluded: this is not enabled in the shell.
export function createStore(file, safeStorage, options = {}) {
  const platform = options.platform ?? process.platform;
  const replace = options.rename ?? rename;
  const openTemp = options.open ?? open;
  const lock = `${file}.lock`;
  async function locked(fn) {
    if (platform !== 'win32' || !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Secure storage unavailable');
    try {
      const parent = path.dirname(path.resolve(file));
      if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error();
    } catch { throw new Error('Unsafe storage path'); }
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try { await mkdir(lock); acquired = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('Secure storage unavailable'); }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!acquired) throw new Error('Secure storage busy; manual recovery may be required');
    try { return await fn(); } finally { await rmdir(lock).catch(() => {}); }
  }
  async function load() {
    let blob;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error();
      blob = await readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Secure storage is corrupt or inaccessible');
    }
    try {
      const { result } = await safeStorage.decryptStringAsync(blob);
      const values = JSON.parse(result);
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([name, value]) => !KEY_NAMES.includes(name) || typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0'))) throw new Error();
      return values;
    } catch { throw new Error('Secure storage is corrupt or inaccessible'); }
  }
  async function save(values) {
    const temp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
    let handle;
    let created = false;
    try {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(values));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error();
      handle = await openTemp(temp, 'wx', 0o600); created = true;
      await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
      await replace(temp, file);
    } catch { throw new Error('Unable to update secure storage'); }
    finally { if (handle) await handle.close().catch(() => {}); if (created) await unlink(temp).catch(() => {}); }
  }
  function validateName(name) { if (!KEY_NAMES.includes(name)) throw new Error('Unknown key'); }
  return Object.freeze({
    list: () => locked(async () => { const values = await load(); return Object.fromEntries(KEY_NAMES.map((name) => [name, Object.hasOwn(values, name)])); }),
    set: (name, value) => locked(async () => {
      validateName(name);
      if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) throw new Error('Invalid key');
      const values = await load(); values[name] = value; await save(values);
    }),
    clear: (name) => locked(async () => { validateName(name); const values = await load(); delete values[name]; await save(values); }),
  });
}
