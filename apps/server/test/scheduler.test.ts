import { expect, test, vi } from "vitest";
import { openDatabase } from "../src/db/index.ts";
import { topics } from "../src/db/schema.ts";
import { createScheduler } from "../src/pipeline/scheduler.ts";

test("catches up only once, then runs at the next cron boundary", async () => {
  const db = openDatabase(":memory:");
  try {
    db.insert(topics)
      .values({
        id: "a",
        title: "A",
        mode: "standard",
        lang: "en",
        minutes: 8,
        schedule: "0 * * * *",
        lastRunAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    let now = new Date("2026-01-01T04:30:00.000Z");
    const run = vi.fn(async () => {});
    const scheduler = createScheduler({ db, run, now: () => now });
    await scheduler.tick();
    await scheduler.tick();
    expect(run.mock.calls).toEqual([["a"]]);
    now = new Date("2026-01-01T05:00:00.000Z");
    await scheduler.tick();
    expect(run.mock.calls).toEqual([["a"], ["a"]]);
  } finally {
    db.$client.close();
  }
});

test("an invalid schedule does not block other topics", async () => {
  const db = openDatabase(":memory:");
  try {
    for (const [id, schedule] of [
      ["bad", "not cron"],
      ["good", "0 * * * *"],
    ]) {
      db.insert(topics)
        .values({
          id: id!,
          title: id!,
          mode: "standard",
          lang: "en",
          minutes: 8,
          schedule,
          lastRunAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
    }
    const run = vi.fn(async () => {});
    const scheduler = createScheduler({ db, run, now: () => new Date("2026-01-01T02:00:00.000Z") });
    await expect(scheduler.tick()).rejects.toThrow();
    expect(run.mock.calls).toEqual([["good"]]);
  } finally {
    db.$client.close();
  }
});

test("new and disabled topics do not catch up; new topics run at a future boundary", async () => {
  const db = openDatabase(":memory:");
  try {
    db.insert(topics)
      .values([
        {
          id: "new",
          title: "New",
          mode: "standard",
          lang: "en",
          minutes: 8,
          schedule: "0 * * * *",
        },
        {
          id: "disabled",
          title: "Disabled",
          mode: "standard",
          lang: "en",
          minutes: 8,
          schedule: "0 * * * *",
          enabled: false,
          lastRunAt: "2026-01-01T00:00:00.000Z",
        },
      ])
      .run();
    let now = new Date("2026-01-01T02:30:00.000Z");
    const run = vi.fn(async () => {});
    const scheduler = createScheduler({ db, run, now: () => now });
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    now = new Date("2026-01-01T03:00:00.000Z");
    await scheduler.tick();
    expect(run.mock.calls).toEqual([["new"]]);
  } finally {
    db.$client.close();
  }
});

test("failed submissions remain due and overlapping ticks do not duplicate jobs", async () => {
  const db = openDatabase(":memory:");
  try {
    db.insert(topics)
      .values({
        id: "a",
        title: "A",
        mode: "standard",
        lang: "en",
        minutes: 8,
        schedule: "0 * * * *",
        lastRunAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockImplementationOnce(async () => gate);
    const scheduler = createScheduler({ db, run, now: () => new Date("2026-01-01T02:00:00.000Z") });
    await expect(scheduler.tick()).rejects.toThrow();
    expect(db.select().from(topics).get()?.lastRunAt).toBe("2026-01-01T00:00:00.000Z");
    const first = scheduler.tick();
    const second = scheduler.tick();
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    db.$client.close();
  }
});
