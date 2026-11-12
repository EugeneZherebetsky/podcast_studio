import { expect, it } from "vitest";
import { playbackQueue } from "./playback-queue";
import { syncPlayback } from "./playback-sync";

it("persists playback and retains changes made during a sync", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItemSync: (key: string) => data.get(key) ?? null,
    setItemSync: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const queue = playbackQueue(storage);
  const first = {
    episodeId: "episode",
    positionMs: 10,
    finished: false,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const next = { ...first, positionMs: 20, updatedAt: "2026-01-02T00:00:00Z" };
  queue.record(first);
  await syncPlayback(queue, async () => {
    queue.record(next);
    return { ok: true };
  });
  expect(playbackQueue(storage).pending()).toEqual([next]);
  await syncPlayback(queue, async () => ({ ok: true }));
  expect(playbackQueue(storage).pending()).toEqual([]);
});

it("keeps newer positions and refuses corrupted storage without overwriting it", () => {
  let value: string | null = null;
  const storage = {
    getItemSync: () => value,
    setItemSync: (_key: string, next: string) => {
      value = next;
    },
  };
  const queue = playbackQueue(storage);
  const position = {
    episodeId: "episode",
    positionMs: 20,
    finished: false,
    updatedAt: "2026-01-02T00:00:00Z",
  };
  queue.record(position);
  queue.record({ ...position, positionMs: 10, updatedAt: "2026-01-01T00:00:00Z" });
  expect(queue.pending()).toEqual([position]);
  value = "broken";
  expect(() => queue.record(position)).toThrow();
  expect(value).toBe("broken");
});
