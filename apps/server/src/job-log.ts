import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { STAGE_NAMES, type StageName } from "shared";

export type Progress =
  | { kind: "job"; status: "queued" | "started" | "completed" | "failed" | "cancelled" }
  | {
      kind: "stage";
      stage: StageName;
      status: "running" | "done" | "skipped" | "failed";
      elapsedMs?: number;
    }
  | {
      kind: "map";
      status: "started" | "done" | "failed" | "cached";
      index: number;
      total: number;
      elapsedMs?: number;
    }
  | { kind: "merge"; status: "started" | "done" | "failed"; elapsedMs?: number }
  | ({ kind: "request" } & RequestDiagnostic)
  | { kind: "selection"; provider: string; model: string | null }
  | { kind: "chatgpt"; stage: StageName; bytes: number; events: number; elapsedMs: number };

type RequestDiagnostic = { stage: StageName; status: "sent" | "completed" | "failed" | "timed out" | "cancelled"; provider: string; model: string | null; index: number; elapsedMs?: number };
const providers = new Set(["ollama", "openai", "anthropic", "gemini", "chatgpt", "fake", "unknown"]);
const modelAllowlist = new Set(["qwen:4b", "qwen3:4b", "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5.2", "fake-main", "fake-fast"]);
export function safeModel(value: unknown): string | null {
  return typeof value === "string" && modelAllowlist.has(value) ? value : null;
}


export function publicJobError(error: string | null): string | null {
  if (error === null) return null;
  if (["Cloud TTS failed; the provider may have billed this request", "Cloud TTS may have billed this request; stop the server and follow manual recovery in SETUP.md"].includes(error)) return error;
  if (["Timeout", "Request cancelled or timed out", "ChatGPT request timed out; remote work may still be running", "ChatGPT request cancelled; remote work may still be running"].includes(error)) return error;
  return "Job failed.";
}

type Entry = { timestamp: string; message: string; request?: RequestDiagnostic; selection?: { provider: string; model: string | null } };
const limit = 500;
const safeDuration = (n: number | undefined) =>
  Number.isSafeInteger(n) && n! >= 0 ? ` (${n} ms)` : "";
function describe(progress: Progress): string {
  switch (progress.kind) {
    case "job":
      if (!["queued", "started", "completed", "failed", "cancelled"].includes(progress.status))
        throw new Error("Invalid progress");
      return `Job ${progress.status}`;
    case "stage":
      if (
        !STAGE_NAMES.includes(progress.stage) ||
        !["running", "done", "skipped", "failed"].includes(progress.status)
      )
        throw new Error("Invalid progress");
      return `${progress.stage} ${progress.status}${safeDuration(progress.elapsedMs)}`;
    case "map":
      if (
        !Number.isSafeInteger(progress.index) ||
        !Number.isSafeInteger(progress.total) ||
        progress.index < 1 ||
        progress.index > progress.total ||
        progress.total > 100000 ||
        !["started", "done", "failed", "cached"].includes(progress.status)
      )
        throw new Error("Invalid progress");
      return `Map ${progress.index}/${progress.total} ${{ started: "started", done: "completed", failed: "failed", cached: "used cache" }[progress.status]}${safeDuration(progress.elapsedMs)}`;
    case "selection":
      if (!providers.has(progress.provider) || (progress.model !== null && safeModel(progress.model) !== progress.model)) throw new Error("Invalid selection diagnostic");
      return `Selected provider: ${progress.provider}${progress.model ? ` / ${progress.model}` : " / model unavailable"}`;
    case "request":
      if (!STAGE_NAMES.includes(progress.stage) || !["sent", "completed", "failed", "timed out", "cancelled"].includes(progress.status) || !providers.has(progress.provider) || (progress.model !== null && safeModel(progress.model) !== progress.model) || !Number.isSafeInteger(progress.index) || progress.index < 1 || progress.index > 100000 || (progress.elapsedMs !== undefined && (!Number.isSafeInteger(progress.elapsedMs) || progress.elapsedMs < 0))) throw new Error("Invalid request diagnostic");
      return `${progress.stage} request ${progress.index} ${progress.status}: ${progress.provider}${progress.model ? ` / ${progress.model}` : ""}${safeDuration(progress.elapsedMs)}`;
    case "chatgpt":
      if (!STAGE_NAMES.includes(progress.stage) || [progress.bytes, progress.events, progress.elapsedMs].some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error("Invalid progress");
      return `ChatGPT ${progress.stage}: ${progress.events} events, ${progress.bytes} bytes received${safeDuration(progress.elapsedMs)}`;
    case "merge":
      if (!["started", "done", "failed"].includes(progress.status))
        throw new Error("Invalid progress");
      return `Merge ${{ started: "started", done: "completed", failed: "failed" }[progress.status]}${safeDuration(progress.elapsedMs)}`;
  }
}

export function createJobLog(dataDir: string) {
  const dir = path.join(dataDir, "job-logs");
  const file = (id: string) =>
    path.join(dir, `${createHash("sha256").update(id).digest("hex")}.jsonl`);
  const check = (target: string) => {
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw new Error("Log storage unavailable");
  };
  function read(id: string): { available: boolean; partial?: boolean; entries: Entry[] } {
    check(dir);
    if (existsSync(dir) && !lstatSync(dir).isDirectory())
      throw new Error("Log storage unavailable");
    const target = file(id);
    check(target);
    if (!existsSync(target)) return { available: false, entries: [] };
    const text = readFileSync(target, "utf8");
    if (text.length > 256_000) throw new Error("Log storage unavailable");
    const entries = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);
    // A failed write or an older evicted log cannot be detected after restart.
    return { available: true, partial: true, entries: entries.slice(-limit) };
  }
  return {
    read,
    append(id: string, progress: Progress) {
      const message = describe(progress);
      check(dir);
      mkdirSync(dir, { recursive: true });
      const target = file(id);
      check(target);
      const previous = read(id).entries;
      const request = progress.kind === "request" ? { stage: progress.stage, status: progress.status, provider: progress.provider, model: progress.model, index: progress.index, ...(progress.elapsedMs === undefined ? {} : { elapsedMs: progress.elapsedMs }) } : undefined;
      const selection = progress.kind === "selection" ? { provider: progress.provider, model: progress.model } : undefined;
      const line = JSON.stringify({ timestamp: new Date().toISOString(), message, ...(request ? { request } : {}), ...(selection ? { selection } : {}) }) + "\n";
      if (previous.length < limit) appendFileSync(target, line);
    },
  };
}
