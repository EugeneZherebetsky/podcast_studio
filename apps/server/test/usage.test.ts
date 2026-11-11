import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDatabase, type Db } from "../src/db/index.ts";
import * as t from "../src/db/schema.ts";
import type { Usage } from "../src/providers/llm/interface.ts";
import { monthTotalCostUsd, recordLlmUsage } from "../src/usage.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = makeTempDir();
  db = openDatabase(path.join(dir, "app.db"));
});

afterEach(() => {
  if (db.$client.open) db.$client.close();
  removeTempDir(dir);
});

const usage: Usage = {
  provider: "anthropic",
  model: "model-main",
  inputTokens: 1200,
  outputTokens: 300,
  costUsd: 0.0081,
};

test("recordLlmUsage writes one 'llm' row with the token total and the cost", () => {
  recordLlmUsage(db, usage, { now: new Date("2026-11-11T09:30:00.000Z") });

  expect(db.select().from(t.usage).all()).toEqual([
    {
      id: 1,
      ts: "2026-11-11T09:30:00.000Z",
      provider: "anthropic",
      kind: "llm",
      units: 1500,
      costUsd: 0.0081,
      jobId: null,
    },
  ]);
});

test("recordLlmUsage links the row to a job when given one", () => {
  db.insert(t.jobs)
    .values({
      id: "job-01",
      status: "running",
      options: { title: "T", brief: "", mode: "standard", lang: "en", minutes: 5 },
      createdAt: "2026-11-11T09:00:00.000Z",
      updatedAt: "2026-11-11T09:00:00.000Z",
    })
    .run();

  recordLlmUsage(db, usage, { jobId: "job-01" });

  const [row] = db.select().from(t.usage).all();
  expect(row).toMatchObject({ kind: "llm", jobId: "job-01" });
  expect(Number.isNaN(Date.parse(row!.ts))).toBe(false);
});

test("monthTotalCostUsd is 0 when nothing was recorded", () => {
  expect(monthTotalCostUsd(db, new Date("2026-11-11T09:30:00.000Z"))).toBe(0);
});

test("monthTotalCostUsd sums the current UTC month only, across every kind of usage", () => {
  const at = (iso: string, costUsd: number) =>
    recordLlmUsage(db, { ...usage, costUsd }, { now: new Date(iso) });

  at("2026-10-31T23:59:59.999Z", 100); // last month
  at("2026-11-01T00:00:00.000Z", 0.25); // first instant of the month
  at("2026-11-11T09:30:00.000Z", 0.5);
  at("2026-11-30T23:59:59.999Z", 1); // last instant of the month
  at("2026-12-01T00:00:00.000Z", 100); // next month
  at("2025-11-15T12:00:00.000Z", 100); // same month, last year
  db.insert(t.usage)
    .values({
      ts: "2026-11-05T08:00:00.000Z",
      provider: "azure",
      kind: "tts",
      units: 2000,
      costUsd: 0.125,
    })
    .run();

  expect(monthTotalCostUsd(db, new Date("2026-11-11T12:00:00.000Z"))).toBeCloseTo(1.875, 10);
  expect(monthTotalCostUsd(db, new Date("2026-12-25T00:00:00.000Z"))).toBeCloseTo(100, 10);
  expect(monthTotalCostUsd(db, new Date("2026-09-01T00:00:00.000Z"))).toBe(0);
});
