import { describe, expect, it } from "vitest";
import { segmentAt, tokenParts } from "./transcript";

const segments = [{ startMs: 100, endMs: 500 }, { startMs: 700, endMs: 1000 }];
const house = { surface: "házamban", lemma: "ház", pos: "noun", gloss: "in my house", morphemes: [{ form: "-ban", meaning: "in" }] };

describe("offline transcript", () => {
  it("finds the active sentence only within its half-open timing interval", () => {
    expect([-1, 100, 499, 500, 699, 700, 1000].map((ms) => segmentAt(segments, ms))).toEqual([-1, 0, 0, -1, -1, 1, -1]);
  });
  it("preserves text and punctuation while associating matching words", () => {
    expect(tokenParts("A házamban, házamban!", [house, house])).toEqual([
      { text: "A " }, { text: "házamban", token: house }, { text: ", " },
      { text: "házamban", token: house }, { text: "!" },
    ]);
  });
  it("does not attach annotations to partial words or mismatched text", () => {
    expect(tokenParts("A házamban!", [{ ...house, surface: "ház" }])).toEqual([{ text: "A házamban!" }]);
    expect(tokenParts("Plain text.", [])).toEqual([{ text: "Plain text." }]);
  });
});
