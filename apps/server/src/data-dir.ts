import { mkdirSync } from "node:fs";
import path from "node:path";

export interface DataDirs {
  root: string;
  /** SQLite database file; created by `openDatabase`, not here. */
  dbFile: string;
  /** Published episode packages: `episodes/<id>/{audio.m4a, episode.json}`. */
  episodes: string;
  /** Per-job stage artifacts: `jobs/<jobId>/`. */
  jobs: string;
  /** Synthesised segment WAVs, keyed by content hash. */
  ttsCache: string;
}

/** Creates the data directory and its subdirectories if missing. Safe to call repeatedly. */
export function ensureDataDirs(dataDir: string): DataDirs {
  const root = path.resolve(dataDir);
  const dirs: DataDirs = {
    root,
    dbFile: path.join(root, "app.db"),
    episodes: path.join(root, "episodes"),
    jobs: path.join(root, "jobs"),
    ttsCache: path.join(root, "cache", "tts"),
  };
  for (const dir of [dirs.root, dirs.episodes, dirs.jobs, dirs.ttsCache]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot create data directory ${dir}: ${reason}`, { cause: error });
    }
  }
  return dirs;
}
