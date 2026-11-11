import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeTtsProvider } from "../src/providers/tts/fake.ts";
import { encodeWav, WAV_HEADER_BYTES, WAV_SAMPLE_RATE } from "../src/providers/tts/wav.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => removeTempDir(dir));

const request = { text: "Hello there", lang: "en", voice: "fake-en-a", rate: 1 };

/** An independent reading of the canonical 44-byte PCM WAV header. */
function parseWav(file: Buffer) {
  return {
    riff: file.toString("ascii", 0, 4),
    riffSize: file.readUInt32LE(4),
    wave: file.toString("ascii", 8, 12),
    fmt: file.toString("ascii", 12, 16),
    fmtSize: file.readUInt32LE(16),
    format: file.readUInt16LE(20),
    channels: file.readUInt16LE(22),
    sampleRate: file.readUInt32LE(24),
    byteRate: file.readUInt32LE(28),
    blockAlign: file.readUInt16LE(32),
    bitsPerSample: file.readUInt16LE(34),
    data: file.toString("ascii", 36, 40),
    dataSize: file.readUInt32LE(40),
    samples: Array.from({ length: (file.length - 44) / 2 }, (_, i) => file.readInt16LE(44 + i * 2)),
  };
}

/** Tone frequency from upward zero crossings; exact enough to tell test tones apart. */
function dominantHz(samples: number[]): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) crossings++;
  }
  return crossings / (samples.length / WAV_SAMPLE_RATE);
}

test("writes a valid mono 24 kHz 16-bit PCM WAV with one tone", async () => {
  const tts = new FakeTtsProvider({ outDir: dir });
  const { wavPath, chars } = await tts.synthesize(request);
  const file = readFileSync(wavPath);
  const wav = parseWav(file);

  expect(chars).toBe(11);
  expect(path.dirname(wavPath)).toBe(dir);
  expect(path.extname(wavPath)).toBe(".wav");
  expect(wav).toMatchObject({
    riff: "RIFF",
    riffSize: file.length - 8,
    wave: "WAVE",
    fmt: "fmt ",
    fmtSize: 16,
    format: 1,
    channels: 1,
    sampleRate: 24000,
    byteRate: 48000,
    blockAlign: 2,
    bitsPerSample: 16,
    data: "data",
    dataSize: file.length - 44,
  });
  expect(Math.max(...wav.samples)).toBeGreaterThan(8000); // audible, not silence
  expect(Math.max(...wav.samples.map(Math.abs))).toBeLessThan(32767); // no clipping
  expect(dominantHz(wav.samples)).toBeCloseTo(440, -1);
});

test("duration is proportional to the text length: 50 ms per character by default", async () => {
  const tts = new FakeTtsProvider({ outDir: dir });
  for (const text of ["a", "Hello there", "x".repeat(40)]) {
    const { wavPath, chars } = await tts.synthesize({ ...request, text });
    const wav = parseWav(readFileSync(wavPath));
    expect(chars).toBe(text.length);
    expect(wav.samples).toHaveLength(text.length * 1200); // 50 ms at 24 kHz
    expect(wav.dataSize).toBe(text.length * 1200 * 2);
    expect(tts.expectedSamples(text)).toBe(text.length * 1200);
  }
});

test("ms per character is configurable and characters are counted as code points", async () => {
  const tts = new FakeTtsProvider({ outDir: dir, msPerChar: 10 });
  const { wavPath, chars } = await tts.synthesize({ ...request, text: "ő🙂z", lang: "hu" });
  expect(chars).toBe(3);
  expect(parseWav(readFileSync(wavPath)).samples).toHaveLength(3 * 240);
});

test("the test chooses the tone frequency, fixed or per request", async () => {
  const fixed = new FakeTtsProvider({ outDir: dir, frequencyHz: 880 });
  const a = parseWav(readFileSync((await fixed.synthesize(request)).wavPath));
  expect(dominantHz(a.samples)).toBeCloseTo(880, -1);

  const perRequest = new FakeTtsProvider({
    outDir: dir,
    frequencyHz: (r) => (r.lang === "hu" ? 300 : 600),
  });
  const hu = await perRequest.synthesize({ ...request, lang: "hu" });
  const en = await perRequest.synthesize(request);
  expect(hu.wavPath).not.toBe(en.wavPath);
  expect(dominantHz(parseWav(readFileSync(hu.wavPath)).samples)).toBeCloseTo(300, -1);
  expect(dominantHz(parseWav(readFileSync(en.wavPath)).samples)).toBeCloseTo(600, -1);
});

test("is deterministic: same request, same path and same bytes", async () => {
  const tts = new FakeTtsProvider({ outDir: dir });
  const first = await tts.synthesize(request);
  const firstBytes = readFileSync(first.wavPath);
  const second = await tts.synthesize(request);
  expect(second).toEqual(first);
  expect(readFileSync(second.wavPath).equals(firstBytes)).toBe(true);

  const other = await tts.synthesize({ ...request, text: "Hello there!" });
  expect(other.wavPath).not.toBe(first.wavPath);
  expect(tts.calls).toEqual([request, request, { ...request, text: "Hello there!" }]);
});

test("lists canned voices for the primary language tag", async () => {
  const tts = new FakeTtsProvider({ outDir: dir });
  const hu = await tts.voices("hu-HU");
  expect(hu.map((voice) => voice.id)).toEqual(["fake-hu-a", "fake-hu-b"]);
  expect(hu.every((voice) => voice.lang === "hu")).toBe(true);
  expect(await tts.voices("en")).toEqual(await tts.voices("en"));
});

test("rejects empty text and nonsensical frequencies", async () => {
  const tts = new FakeTtsProvider({ outDir: dir, frequencyHz: 20000 });
  await expect(tts.synthesize({ ...request, text: "" })).rejects.toThrowError(/empty text/);
  await expect(tts.synthesize(request)).rejects.toThrowError(/frequency/);
});

test("encodeWav wraps samples in a 44-byte header", () => {
  const wav = encodeWav(Int16Array.from([0, 1, -1, 32767, -32768]));
  expect(WAV_HEADER_BYTES).toBe(44);
  expect(wav).toHaveLength(44 + 10);
  expect(parseWav(wav).samples).toEqual([0, 1, -1, 32767, -32768]);
});
