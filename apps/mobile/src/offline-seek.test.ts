import { expect, it, vi } from "vitest";
import { createSeekCheckpoint, offlinePlayback } from "./offline-playback";

it("does not checkpoint a failed seek", async () => {
  const storage = { getItemSync: () => "12", setItemSync: vi.fn() };
  const checkpoint = createSeekCheckpoint(offlinePlayback(storage, "episode"));
  await expect(checkpoint.seek(42, async () => { throw new Error("seek failed"); })).rejects.toThrow("seek failed");
  expect(storage.setItemSync).not.toHaveBeenCalled();
  expect(checkpoint.acceptClock(12, false)).toBe(true);
});

it("does not let an older seek completion overwrite a newer checkpoint", async () => {
  const storage = { getItemSync: () => null, setItemSync: vi.fn() };
  const checkpoint = createSeekCheckpoint(offlinePlayback(storage, "episode"));
  let resolve!: () => void;
  const older = checkpoint.seek(10, () => new Promise<void>((done) => { resolve = done; }));
  await Promise.resolve();
  expect(checkpoint.acceptClock(5, false)).toBe(false);
  const newer = checkpoint.seek(42, async () => {});
  resolve();
  expect(await older).toBe(false);
  await newer;
  expect(storage.setItemSync).toHaveBeenCalledTimes(1);
  expect(storage.setItemSync).toHaveBeenCalledWith("offline-position-v1:episode", "42");
  expect(checkpoint.acceptClock(10, false)).toBe(false);
  expect(checkpoint.acceptClock(42, true)).toBe(false);
  expect(checkpoint.acceptClock(42, false)).toBe(true);
});

it("reports a storage failure without reporting a seek failure", async () => {
  const onError = vi.fn();
  const storage = { getItemSync: () => null, setItemSync: () => { throw new Error("storage failed"); } };
  const checkpoint = createSeekCheckpoint(offlinePlayback(storage, "episode"), onError);
  await expect(checkpoint.seek(42, async () => {})).resolves.toBe(true);
  expect(onError).toHaveBeenCalledOnce();
});
