import { describe, expect, it } from "vitest";
import { checkTtsInputLimit } from "../src/providers/tts/input-limit.ts";

describe("cloud TTS input preflight", () => {
  it("counts the complete script in UTF-8 bytes and UTF-16 code units before synthesis", () => {
    expect(checkTtsInputLimit(["abc", "é😀"], 9)).toEqual({ bytes: 9, characters: 6 });
    expect(() => checkTtsInputLimit(["abc", "é😀"], 8)).toThrow(/limit/i);
  });

  it("fails closed on missing, fractional, zero, negative or non-finite limits", () => {
    for (const limit of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => checkTtsInputLimit(["x"], limit)).toThrow(/limit/i);
    }
  });
});
