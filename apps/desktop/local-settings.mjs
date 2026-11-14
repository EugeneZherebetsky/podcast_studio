import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

export function samePiperPath(left, right, platform = process.platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function validate(value) {
  if (!value || !['executable', 'native', 'hu'].every((key) => typeof value[key] === 'string' && path.isAbsolute(value[key]))) throw new Error('Select the Piper executable and both voice models.');
  const exe = path.normalize(value.executable);
  const expected = process.platform === 'win32' ? ['Scripts', 'piper.exe'] : ['bin', 'piper'];
  if (!samePiperPath(path.basename(exe), expected[1]) || !samePiperPath(path.basename(path.dirname(exe)), expected[0]) || !samePiperPath(path.basename(path.dirname(path.dirname(exe))), 'venv')) throw new Error('Select Piper from the Piper home venv directory.');
  const dir = path.dirname(path.dirname(path.dirname(exe)));
  const voices = path.join(dir, 'voices');
  const files = [exe];
  const names = [];
  for (const key of ['native', 'hu']) {
    const file = path.normalize(value[key]);
    if (!samePiperPath(path.dirname(file), voices) || !/^[a-z]{2}_[A-Z]{2}-[\w-]+\.onnx$/.test(path.basename(file)) || (key === 'hu' && !path.basename(file).startsWith('hu_')) || (key === 'native' && !path.basename(file).startsWith('en_'))) throw new Error('Choose English and Hungarian ONNX voices from the Piper home voices folder, using standard Piper filenames.');
    files.push(file, `${file}.json`);
    names.push(path.basename(file, '.onnx'));
  }
  for (const file of files) if (!(await stat(file)).isFile()) throw new Error('Piper executable and both matching ONNX and ONNX.json files must exist.');
  return { PIPER_DIR: dir, TTS_VOICE_NATIVE_HOST: names[0], TTS_VOICE_HU_HOST: names[1] };
}
export const defaultServices = Object.freeze({ ollama: 'http://localhost:11434/v1', model: 'qwen3.5:4b', searxng: 'http://localhost:8888' });

function validateServices(value) {
  for (const key of ['ollama', 'searxng']) {
    const text = value?.[key];
    if (typeof text !== 'string' || text.length > 2048 || !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(text)) throw new Error('Endpoints must be HTTP URLs on localhost, 127.0.0.1, or [::1], without credentials.');
    let url;
    try { url = new URL(text); } catch { throw new Error('Invalid local service URL.'); }
    if (url.username || url.password || url.hash || url.search || /[?#\s\\]/.test(text)) throw new Error('Endpoints cannot contain credentials, query strings, fragments, whitespace, or backslashes.');
  }
  if (typeof value.model !== 'string' || value.model.length > 256 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[a-z0-9][a-z0-9._-]*)?$/i.test(value.model) || /(?:^|[/:._-])cloud(?:$|[/:._-])/i.test(value.model)) throw new Error('Enter a valid local Ollama model name; cloud models are not allowed.');
  return { ollama: value.ollama, model: value.model, searxng: value.searxng };
}
export async function readServices(home) {
  const target = path.join(home, 'service-settings.json');
  let text;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaultServices }; throw new Error(`Cannot read local service settings at ${target}. Check file permissions; the file was not changed.`, { cause: error }); }
  try { return validateServices(JSON.parse(text)); }
  catch (error) { throw new Error(`Invalid local service settings at ${target}. The file was not changed. Back up the file, then edit it to correct its JSON and local service values before reopening the app.`, { cause: error }); }
}
export async function saveServices(home, value) {
  const valid = validateServices(value);
  const target = path.join(home, 'service-settings.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(valid), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function readPiper(home) {
  try { return await validate(JSON.parse(await readFile(path.join(home, 'piper-settings.json'), 'utf8'))); } catch { return null; }
}
export async function savePiper(home, value) {
  await validate(value);
  const target = path.join(home, 'piper-settings.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ executable: value.executable, native: value.native, hu: value.hu }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
