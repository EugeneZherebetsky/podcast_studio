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
  | { kind: "merge"; status: "started" | "done" | "failed"; elapsedMs?: number };

export function publicJobError(error: string | null): string | null {
  if (error === null) return null;
  if (error === "Timeout" || error === "Request cancelled or timed out") return error;
  return "Job failed.";
}

type Entry = { timestamp: string; message: string };
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
      const line = JSON.stringify({ timestamp: new Date().toISOString(), message }) + "\n";
      if (previous.length < limit) appendFileSync(target, line);
    },
  };
}
