// Stage 9, `publish` (ARCHITECTURE §3): the episode package appears in one step.
//
// 1. stage:  write audio.m4a and episode.json into `episodes/.<id>.<random>.tmp/`, a
//            sibling of the final directory and therefore on the same volume;
// 2. rename: move that directory to `episodes/<id>/` (atomic on one volume);
// 3. record: insert the `episodes` row, which is what makes the episode visible.
//
// A crash before 2 leaves a staging directory nobody reads; a crash between 2 and 3 leaves
// a whole package nobody lists. Both are cleaned up or replaced by the next run. A crash
// after 3 leaves a whole, listed episode, which the next run keeps as it is.
//
// The caller must be the only one publishing this id. Database owner tokens do not fence
// filesystem writes; the runner disables recovery until publication can be fenced.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { EpisodeSchema, type Episode } from "shared";
import type { Db } from "../db/index.ts";
import { episodes } from "../db/schema.ts";

export type PublishStep = "staged" | "renamed" | "recorded";

export interface PublishOptions {
  db: Db;
  dataDir: string;
  /** episode.json without `audio`, which is measured from the staged copy of the file. */
  episode: Omit<Episode, "audio">;
  /** The assembled audio in the job's work directory. */
  audioPath: string;
  /** Test seam: runs after each step; throwing stands in for the process dying there. */
  afterStep?: (step: PublishStep) => void | Promise<void>;
}

export interface PublishResult {
  /** `episodes/<id>/` */
  dir: string;
  /** True when a complete, listed episode was already there and was left untouched. */
  reused: boolean;
}

const AUDIO_FILE = "audio.m4a";
const METADATA_FILE = "episode.json";
/** Same rule as the delete route: the id is a directory name and nothing else. */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
/** What Windows reports while a scanner, an indexer or a reader holds the directory. */
const IN_USE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];

async function measure(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Writes the file and forces it to disk, so the rename never exposes unwritten data. */
async function writeDurably(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** Valid metadata for this id that describes exactly the audio file next to it. */
async function isCompletePackage(dir: string, id: string): Promise<boolean> {
  try {
    const episode = EpisodeSchema.parse(
      JSON.parse(await readFile(path.join(dir, METADATA_FILE), "utf8")),
    );
    if (episode.id !== id) return false;
    const audio = await measure(path.join(dir, episode.audio.file));
    return audio.bytes === episode.audio.bytes && audio.sha256 === episode.audio.sha256;
  } catch {
    return false;
  }
}

async function removeQuietly(target: string): Promise<void> {
  // Nobody reads these directories; one that cannot be removed now is retried next time.
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  );
}

/** `rename` that waits out a short lock; the target must not exist. */
async function renameUnlessInUse(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!IN_USE_CODES.has(code)) throw error;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined)
        throw new Error(
          `Cannot publish: ${path.basename(from)} or ${path.basename(to)} in the episodes ` +
            `directory is in use (${code}). Close whatever has it open and resume the job.`,
          { cause: error },
        );
      await sleep(delay);
    }
  }
}

export async function publishEpisode(options: PublishOptions): Promise<PublishResult> {
  const { db, afterStep } = options;
  const { id } = options.episode;
  if (!SAFE_ID.test(id)) throw new Error(`Cannot publish: unsafe episode id "${id}"`);
  const root = path.join(options.dataDir, "episodes");
  const finalDir = path.join(root, id);
  const ours = (name: string) => path.join(root, `.${id}.${randomUUID()}.${name}`);
  await mkdir(root, { recursive: true });

  // Leftovers of runs that died: staging directories and packages that were set aside.
  for (const name of await readdir(root)) {
    if (name.startsWith(`.${id}.`) && (name.endsWith(".tmp") || name.endsWith(".old")))
      await removeQuietly(path.join(root, name));
  }

  const row = db.select().from(episodes).where(eq(episodes.id, id)).get();
  if (
    row &&
    path.resolve(row.path) === path.resolve(finalDir) &&
    (await isCompletePackage(finalDir, id))
  ) {
    // Already published by a run that died before it could say so. Devices may have
    // fetched it, so it is kept rather than replaced by a re-encoded copy.
    return { dir: finalDir, reused: true };
  }

  const staging = ours("tmp");
  /** An ordinary failure tidies up at once; only a crash leaves the staging directory. */
  const orDiscard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      await removeQuietly(staging);
      throw error;
    }
  };

  const episode = await orDiscard(async () => {
    await mkdir(staging);
    const stagedAudio = path.join(staging, AUDIO_FILE);
    await copyFile(options.audioPath, stagedAudio);
    await syncFile(stagedAudio);
    const parsed = EpisodeSchema.parse({
      ...options.episode,
      audio: { file: AUDIO_FILE, ...(await measure(stagedAudio)) },
    });
    await writeDurably(path.join(staging, METADATA_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  });
  await afterStep?.("staged");

  await orDiscard(async () => {
    if (!(await exists(finalDir))) return renameUnlessInUse(staging, finalDir);
    // Whatever is there is not a listed, complete episode (that case returned above): an
    // unlisted leftover, or a damaged package. A directory cannot be renamed over another
    // one, so it steps aside first and comes back if the swap fails.
    const aside = ours("old");
    await renameUnlessInUse(finalDir, aside);
    try {
      await renameUnlessInUse(staging, finalDir);
    } catch (error) {
      await rename(aside, finalDir).catch(() => undefined);
      throw error;
    }
    await removeQuietly(aside);
  });
  await afterStep?.("renamed");

  const values = {
    topicId: episode.topicId ?? null,
    title: episode.title,
    summary: episode.summary,
    mode: episode.mode,
    lang: episode.lang,
    durationMs: episode.durationMs,
    createdAt: episode.createdAt,
    path: finalDir,
  };
  db.insert(episodes)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: episodes.id, set: values })
    .run();
  await afterStep?.("recorded");
  return { dir: finalDir, reused: false };
}
