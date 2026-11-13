import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { createJobLog } from "../src/job-log.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("persists isolated, bounded, safe job progress across store instances", () => {
  const dir = makeTempDir();
  try {
    const log = createJobLog(dir);
    log.append("job-a", { kind: "stage", stage: "notes", status: "running" });
    log.append("job-b", { kind: "stage", stage: "plan", status: "failed" });
    const target = path.join(dir, "job-logs", `${createHash("sha256").update("job-a").digest("hex")}.jsonl`);
    appendFileSync(target, (JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", message: "Map 1/2 completed" }) + "\n").repeat(498));
    for (let i = 0; i < 3; i++)
      log.append("job-a", { kind: "map", status: "done", index: 1, total: 2, elapsedMs: i });
    const loaded = createJobLog(dir);
    const a = loaded.read("job-a");
    expect(a.available).toBe(true);
    expect(a.entries).toHaveLength(500);
    expect(a.entries[0]?.message).toBe("notes running");
    expect(Number.isNaN(Date.parse(a.entries[0]!.timestamp))).toBe(false);
    expect(a.entries.at(-1)?.message).toContain("Map 1/2 completed");
    expect(a.partial).toBe(true);
    expect(loaded.read("job-b").entries[0]?.message).toBe("plan failed");
    expect(loaded.read("missing")).toEqual({ available: false, entries: [] });
  } finally {
    removeTempDir(dir);
  }
}, 30000);

test("persists allowlisted request diagnostics without arbitrary fields", () => {
  const dir = makeTempDir();
  try {
    const log = createJobLog(dir);
    log.append("job", { kind: "request", stage: "script", status: "sent", provider: "ollama", model: "qwen:4b", index: 1, secret: "do-not-save" } as never);
    const entry = createJobLog(dir).read("job").entries[0]!;
    expect(entry).toMatchObject({ request: { stage: "script", status: "sent", provider: "ollama", model: "qwen:4b", index: 1 } });
    expect(JSON.stringify(entry)).not.toContain("do-not-save");
  } finally { removeTempDir(dir); }
});

test("never evicts matching pre-existing files", () => {
  const dir = makeTempDir();
  try {
    const logs = path.join(dir, "job-logs");
    mkdirSync(logs);
    for (let i = 0; i < 205; i++) writeFileSync(path.join(logs, `${i.toString(16).padStart(64, "0")}.jsonl`), "user data");
    createJobLog(dir).append("new-job", { kind: "job", status: "started" });
    expect(readdirSync(logs)).toHaveLength(206);
    expect(readFileSync(path.join(logs, `${"0".repeat(64)}.jsonl`), "utf8")).toBe("user data");
  } finally { removeTempDir(dir); }
});
