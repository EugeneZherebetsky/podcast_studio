import { afterEach, expect, test, vi } from "vitest";
import { readPlaybackSpeed, savePlaybackSpeed } from "./Library.tsx";

afterEach(() => vi.unstubAllGlobals());

test("restores supported rates and rejects missing or invalid values", () => {
  const getItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem });
  for (const value of [null, "", "NaN", "100", "1.1"]) {
    getItem.mockReturnValue(value);
    expect(readPlaybackSpeed()).toBe(1);
  }
  getItem.mockReturnValue("1.25");
  expect(readPlaybackSpeed()).toBe(1.25);
});

test("saves a rate and tolerates unavailable storage", () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", {
    setItem,
    getItem: () => {
      throw new Error("blocked");
    },
  });
  savePlaybackSpeed(2);
  expect(setItem).toHaveBeenCalledWith("playback-speed-v1", "2");
  expect(readPlaybackSpeed()).toBe(1);
  setItem.mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => savePlaybackSpeed(0.5)).not.toThrow();
});
