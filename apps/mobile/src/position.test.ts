import { describe, expect, it } from "vitest";
import { clampPosition, formatTime } from "./position";

describe("playback position", () => {
  it("clamps seeks and invalid persisted values", () => {
    expect(clampPosition(-20, 100)).toBe(0);
    expect(clampPosition(120, 100)).toBe(100);
    expect(clampPosition(20, 100)).toBe(20);
    expect(clampPosition(NaN, 100)).toBe(0);
    expect(clampPosition(20, 0)).toBe(0);
  });
  it("formats elapsed time", () => {
    expect(formatTime(619)).toBe("10:19");
    expect(formatTime(NaN)).toBe("0:00");
  });
});
