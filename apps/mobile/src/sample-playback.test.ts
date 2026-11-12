import { expect, it } from "vitest";
import { samplePlayback } from "./sample-playback";

it("persists sample checkpoints separately from the server sync queue", () => {
  const data = new Map<string, string>();
  const storage = {
    getItemSync: (key: string) => data.get(key) ?? null,
    setItemSync: (key: string, value: string) => { data.set(key, value); },
  };
  const playback = samplePlayback(storage, "sample");
  playback.record(12.5, false, "2026-01-01T00:00:00.000Z");
  expect(samplePlayback(storage, "sample").position()).toBe(12.5);
  expect(playback.pending()[0]).toMatchObject({ episodeId: "sample", positionMs: 12500, finished: false });
  expect(data.has("pending-playback-v1")).toBe(false);
  playback.record(20, true, "2026-01-01T00:00:01.000Z");
  expect(playback.position()).toBe(0);
  expect(playback.pending()[0]).toMatchObject({ positionMs: 20000, finished: true });
});

it("refuses a corrupt saved position instead of silently replacing it", () => {
  const storage = { getItemSync: () => "bad", setItemSync: () => {} };
  expect(() => samplePlayback(storage, "sample").position()).toThrow();
});

it("preserves a corrupt local queue while retaining the resume checkpoint", () => {
  const data = new Map([["sample-local-playback-v1", "broken"]]);
  const storage = {
    getItemSync: (key: string) => data.get(key) ?? null,
    setItemSync: (key: string, value: string) => { data.set(key, value); },
  };
  const playback = samplePlayback(storage, "sample");
  expect(() => playback.record(15, false)).toThrow();
  expect(playback.position()).toBe(15);
  expect(data.get("sample-local-playback-v1")).toBe("broken");
});
