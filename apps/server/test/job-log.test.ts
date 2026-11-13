import { expect, test } from "vitest";
import { createJobLog } from "../src/job-log.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("persists isolated, bounded, safe job progress across store instances", () => {
  const dir = makeTempDir();
  try {
    const log = createJobLog(dir);
    log.append("job-a", { kind: "stage", stage: "notes", status: "running" });
    log.append("job-b", { kind: "stage", stage: "plan", status: "failed" });
    for (let i = 0; i < 600; i++)
      log.append("job-a", { kind: "map", status: "done", index: 1, total: 2, elapsedMs: i });
    const loaded = createJobLog(dir);
    const a = loaded.read("job-a");
    expect(a.available).toBe(true);
    expect(a.entries.length).toBeLessThanOrEqual(500);
    expect(a.entries.at(-1)?.message).toContain("Map 1/2 completed");
    expect(loaded.read("job-b").entries[0]?.message).toBe("plan failed");
    expect(loaded.read("missing")).toEqual({ available: false, entries: [] });
  } finally {
    removeTempDir(dir);
  }
}, 30000);
