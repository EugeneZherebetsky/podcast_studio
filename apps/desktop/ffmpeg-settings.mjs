import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

async function valid(tools) {
  if (!tools || typeof tools.ffmpeg !== 'string' || typeof tools.ffprobe !== 'string' ||
      !path.isAbsolute(tools.ffmpeg) || !path.isAbsolute(tools.ffprobe) ||
      path.basename(tools.ffmpeg).toLowerCase() !== (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') ||
      path.basename(tools.ffprobe).toLowerCase() !== (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')) return false;
  try { return (await stat(tools.ffmpeg)).isFile() && (await stat(tools.ffprobe)).isFile(); } catch { return false; }
}
export async function readTools(home) {
  try {
    const tools = JSON.parse(await readFile(path.join(home, 'ffmpeg-settings.json'), 'utf8'));
    return await valid(tools) ? { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe } : null;
  } catch { return null; }
}
export async function saveTools(home, tools) {
  if (!await valid(tools)) throw new Error('Select existing ffmpeg and ffprobe executable files.');
  const target = path.join(home, 'ffmpeg-settings.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
