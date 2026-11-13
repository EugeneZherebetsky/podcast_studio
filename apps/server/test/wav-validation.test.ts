import { expect, test } from "vitest";
import { encodeWav, isMono24k16BitPcmWav } from "../src/providers/tts/wav.ts";

test("rejects malformed and empty PCM WAV chunks", () => {
  const valid = encodeWav(Int16Array.from([1, 2]));
  const empty = encodeWav(new Int16Array());
  const oversizedData = Buffer.from(valid); oversizedData.writeUInt32LE(100, 40);
  const oversizedFmt = Buffer.from(valid); oversizedFmt.writeUInt32LE(100, 16);
  const truncated = valid.subarray(0, valid.length - 1);
  const oddData = Buffer.from(valid); oddData.writeUInt32LE(3, 40);
  const badRiff = Buffer.from(valid); badRiff.writeUInt32LE(100, 4);
  expect(isMono24k16BitPcmWav(valid)).toBe(true);
  for (const wav of [empty, oversizedData, oversizedFmt, truncated, oddData, badRiff]) expect(isMono24k16BitPcmWav(wav)).toBe(false);
});
