import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

async function validate(value) {
  if (!value || !['executable', 'native', 'hu'].every((key) => typeof value[key] === 'string' && path.isAbsolute(value[key]))) throw new Error('Select the Piper executable and both voice models.');
  const exe = path.normalize(value.executable);
  const expected = process.platform === 'win32' ? ['Scripts', 'piper.exe'] : ['bin', 'piper'];
  if (path.basename(exe).toLowerCase() !== expected[1] || path.basename(path.dirname(exe)).toLowerCase() !== expected[0].toLowerCase() || path.basename(path.dirname(path.dirname(exe))).toLowerCase() !== 'venv') throw new Error('Select Piper from the Piper home venv directory.');
  const dir = path.dirname(path.dirname(path.dirname(exe)));
  const voices = path.join(dir, 'voices');
  const files = [exe];
  const names = [];
  for (const key of ['native', 'hu']) {
    const file = path.normalize(value[key]);
    if (path.dirname(file) !== voices || !/^[a-z]{2}_[A-Z]{2}-[\w-]+\.onnx$/.test(path.basename(file)) || (key === 'hu' && !path.basename(file).startsWith('hu_')) || (key === 'native' && !path.basename(file).startsWith('en_'))) throw new Error('Choose English and Hungarian ONNX voices from the Piper home voices folder, using standard Piper filenames.');
    files.push(file, `${file}.json`);
    names.push(path.basename(file, '.onnx'));
  }
  for (const file of files) if (!(await stat(file)).isFile()) throw new Error('Piper executable and both matching ONNX and ONNX.json files must exist.');
  return { PIPER_DIR: dir, TTS_VOICE_NATIVE_HOST: names[0], TTS_VOICE_HU_HOST: names[1] };
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
