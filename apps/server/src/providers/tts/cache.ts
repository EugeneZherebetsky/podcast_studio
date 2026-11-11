import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Lang } from "shared";
import {
  countChars,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TtsProvider,
  type Voice,
} from "./interface.ts";
import { isMono24k16BitPcmWav } from "./wav.ts";

const execFileAsync = promisify(execFile);

/** Error thrown for TTS HTTP failures, recording status for retry decisions. */
export class TtsHttpError extends Error {
  readonly status: number;
  readonly isTransient: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TtsHttpError";
    this.status = status;
    this.isTransient = status === 429 || status >= 500;
  }
}

/** Determines whether an error is transient (HTTP 429/5xx or network drop) and safe to retry. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof TtsHttpError) {
    return error.isTransient;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("network error")
    ) {
      return true;
    }
  }
  return false;
}

/** Semaphore limiting in-flight operations (e.g. at most 3 concurrent synthesis calls). */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly limit: number = 3) {
    if (limit < 1) throw new Error("ConcurrencyLimiter limit must be >= 1");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isTransient?: (error: unknown) => boolean;
}

/** Retries an async action with exponential backoff when a transient error occurs. */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialBackoffMs = options.initialBackoffMs ?? 200;
  const maxBackoffMs = options.maxBackoffMs ?? 5000;
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const checkTransient = options.isTransient ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !checkTransient(err)) {
        throw err;
      }
      const delay = Math.min(initialBackoffMs * Math.pow(2, attempt), maxBackoffMs);
      await sleepFn(delay);
    }
  }
  throw lastError;
}

/**
 * Normalises audio (as buffer or path) to mono 24 kHz 16-bit PCM WAV.
 * If already matching, writes or copies directly without spawning ffmpeg.
 */
export async function ensureMono24k16BitPcmWav(
  input: Buffer | string,
  outputPath: string,
): Promise<void> {
  const outDir = path.dirname(outputPath);
  mkdirSync(outDir, { recursive: true });

  if (Buffer.isBuffer(input)) {
    if (isMono24k16BitPcmWav(input)) {
      writeFileSync(outputPath, input);
      return;
    }
    const tempInput = path.join(outDir, `ffmpeg-in-${randomUUID()}.bin`);
    writeFileSync(tempInput, input);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        tempInput,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ]);
    } finally {
      try {
        unlinkSync(tempInput);
      } catch {
        // Ignored
      }
    }
    return;
  }

  const buf = readFileSync(input);
  if (isMono24k16BitPcmWav(buf)) {
    if (path.resolve(input) !== path.resolve(outputPath)) {
      copyFileSync(input, outputPath);
    }
    return;
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    input,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
}

/** Computes sha256(`${provider}:${voice}:${rate}:${lang}:${text}`).wav */
export function computeTtsCacheKey(provider: string, request: SynthesizeRequest): string {
  const raw = `${provider}:${request.voice}:${request.rate}:${request.lang}:${request.text}`;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  return `${hash}.wav`;
}

export interface TtsCacheOptions {
  cacheDir?: string;
  dataDir?: string;
  concurrencyLimit?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class TtsCache {
  readonly cacheDir: string;
  readonly limiter: ConcurrencyLimiter;
  private readonly retryOptions: RetryOptions;

  constructor(options: TtsCacheOptions = {}) {
    if (options.cacheDir) {
      this.cacheDir = path.resolve(options.cacheDir);
    } else {
      const baseDataDir = options.dataDir ?? "./data";
      this.cacheDir = path.resolve(baseDataDir, "cache", "tts");
    }
    this.limiter = new ConcurrencyLimiter(options.concurrencyLimit ?? 3);
    this.retryOptions = {
      maxRetries: options.maxRetries ?? 3,
      initialBackoffMs: options.initialBackoffMs ?? 200,
      sleep: options.sleep,
    };
  }

  computeKey(provider: string, request: SynthesizeRequest): string {
    return computeTtsCacheKey(provider, request);
  }

  getCached(provider: string, request: SynthesizeRequest): SynthesizeResult | null {
    const key = this.computeKey(provider, request);
    const wavPath = path.join(this.cacheDir, key);
    if (existsSync(wavPath)) {
      try {
        const buf = readFileSync(wavPath);
        if (isMono24k16BitPcmWav(buf)) {
          return { wavPath, chars: countChars(request.text) };
        }
      } catch {
        // Invalid or corrupt cache entry
      }
    }
    return null;
  }

  async synthesizeWithCache(
    provider: string,
    request: SynthesizeRequest,
    synthesizer: () => Promise<{ audio: Buffer | string; chars?: number }>,
  ): Promise<SynthesizeResult> {
    // 1. Fast cache hit check before acquiring concurrency slot
    const cached = this.getCached(provider, request);
    if (cached) return cached;

    // 2. Concurrency-limited execution
    return this.limiter.run(async () => {
      // Double check cache in case a concurrent request already synthesized it
      const cachedSecond = this.getCached(provider, request);
      if (cachedSecond) return cachedSecond;

      const result = await retryWithBackoff(synthesizer, this.retryOptions);

      mkdirSync(this.cacheDir, { recursive: true });
      const key = this.computeKey(provider, request);
      const targetPath = path.join(this.cacheDir, key);
      const tempPath = path.join(this.cacheDir, `temp-${randomUUID()}-${key}`);

      await ensureMono24k16BitPcmWav(result.audio, tempPath);
      renameSync(tempPath, targetPath);

      const chars = result.chars ?? countChars(request.text);
      return { wavPath: targetPath, chars };
    });
  }
}

/** Wraps any TtsProvider to add content-hash caching, concurrency limiting and retries. */
export class CachedTtsProvider implements TtsProvider {
  constructor(
    readonly providerName: string,
    readonly inner: TtsProvider,
    readonly cache: TtsCache,
  ) {}

  voices(lang: Lang): Promise<Voice[]> {
    return this.inner.voices(lang);
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    const cached = this.cache.getCached(this.providerName, request);
    if (cached) return cached;

    return this.cache.synthesizeWithCache(this.providerName, request, async () => {
      const res = await this.inner.synthesize(request);
      return { audio: res.wavPath, chars: res.chars };
    });
  }
}
