import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../src/db/index.ts";
import { usage } from "../src/db/schema.ts";
import { cancelJob, createJob, startJob } from "../src/pipeline/runner.ts";

const db = openDatabase(":memory:");
afterEach(() => db.$client.exec("DELETE FROM jobs; DELETE FROM usage"));
const options = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 8 };

test("creates a queued job and pending stage records", () => {
  const job = createJob(db, options, 20);
  expect(job.status).toBe("queued");
  expect(
    db.$client
      .prepare("SELECT count(*) AS n FROM job_stages WHERE job_id = ? AND status = 'pending'")
      .get(job.id),
  ).toEqual({ n: 9 });
});

test("refuses jobs when monthly spending exceeds budget", () => {
  db.insert(usage)
    .values({ ts: new Date().toISOString(), provider: "fake", kind: "llm", units: 1, costUsd: 21 })
    .run();
  expect(() => createJob(db, options, 20)).toThrow(/budget/i);
  expect(db.$client.prepare("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
});

test("start checks current budget, prevents duplicate runners, and cancellation is durable", () => {
  const job = createJob(db, options, 20);
  db.insert(usage)
    .values({ ts: new Date().toISOString(), provider: "fake", kind: "llm", units: 1, costUsd: 21 })
    .run();
  expect(() => startJob(db, job.id, 20)).toThrow(/budget/i);
  db.$client.exec("DELETE FROM usage");
  startJob(db, job.id, 20);
  expect(() => startJob(db, job.id, 20)).toThrow(/running/i);
  cancelJob(db, job.id);
  expect(db.$client.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id)).toEqual({
    status: "cancelled",
  });
});
