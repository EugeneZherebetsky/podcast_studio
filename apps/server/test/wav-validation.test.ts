import { expect, test } from "vitest";
import { encodeWav, isMono24k16BitPcmWav, isWellFormedPcmWav } from "../src/providers/tts/wav.ts";

test("rejects invalid PCM rates and duplicate format chunks", () => {
  const valid = encodeWav(Int16Array.from([1, 2]));
  const zeroRate = Buffer.from(valid); zeroRate.writeUInt32LE(0, 24); zeroRate.writeUInt32LE(0, 28);
  const badByteRate = Buffer.from(valid); badByteRate.writeUInt32LE(1, 28);
  const overflow = Buffer.from(valid); overflow.writeUInt32LE(0x80000001, 24); overflow.writeUInt32LE(2, 28);
  const duplicateFmt = Buffer.concat([valid.subarray(0, 36), valid.subarray(12, 36), valid.subarray(36)]);
  duplicateFmt.writeUInt32LE(duplicateFmt.length - 8, 4);
  const maxRate = Buffer.from(valid); maxRate.writeUInt32LE(0x7fffffff, 24); maxRate.writeUInt32LE(0xfffffffe, 28);
  expect(isWellFormedPcmWav(valid)).toBe(true);
  expect(isWellFormedPcmWav(maxRate)).toBe(true);
  expect(isMono24k16BitPcmWav(maxRate)).toBe(false);
  for (const wav of [zeroRate, badByteRate, overflow, duplicateFmt]) {
    expect(isWellFormedPcmWav(wav)).toBe(false);
    expect(isMono24k16BitPcmWav(wav)).toBe(false);
  }
});

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
