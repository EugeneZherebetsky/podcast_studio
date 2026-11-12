import { expect, it, vi } from "vitest";
import { offlinePlayback } from "./offline-playback";

it("persists independent local positions without sending progress", () => {
  const values = new Map<string, string>();
  const storage = { getItemSync: (key: string) => values.get(key) ?? null, setItemSync: (key: string, value: string) => { values.set(key, value); } };
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  offlinePlayback(storage, "first").record(42, false);
  offlinePlayback(storage, "second").record(17, false);
  expect(offlinePlayback(storage, "first").position()).toBe(42);
  expect(offlinePlayback(storage, "second").position()).toBe(17);
  offlinePlayback(storage, "first").record(50, true);
  expect(offlinePlayback(storage, "first").position()).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
