import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PiperTtsProvider } from "../src/providers/tts/piper.ts";
import { encodeWav, isMono24k16BitPcmWav, sineTone } from "../src/providers/tts/wav.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => removeTempDir(dir));

test("synthesizes a configured local voice safely and caches its normalized audio", async () => {
  writeFileSync(path.join(dir, "en_US-example-medium.onnx"), "model");
  writeFileSync(path.join(dir, "en_US-example-medium.onnx.json"), "{}");
  const run = vi.fn(async () => encodeWav(sineTone(440, 2400)));
  const provider = new PiperTtsProvider({ voicesDir: dir, executable: "piper", dataDir: dir, run });
  const request = {
    text: "Hello; $(unsafe)",
    lang: "en",
    voice: "en_US-example-medium",
    rate: 0.8,
  };
  const first = await provider.synthesize(request);
  expect(isMono24k16BitPcmWav(readFileSync(first.wavPath))).toBe(true);
  expect(first.chars).toBe(Array.from(request.text).length);
  expect(await provider.synthesize(request)).toEqual(first);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(
    "piper",
    expect.arrayContaining(["--length-scale", "1.25"]),
    request.text,
  );
});

test("rejects traversal, wrong language and invalid rate without spawning", async () => {
  writeFileSync(path.join(dir, "en_US-example-medium.onnx"), "model");
  writeFileSync(path.join(dir, "en_US-example-medium.onnx.json"), "{}");
  const run = vi.fn(async () => encodeWav(sineTone(440, 2400)));
  const provider = new PiperTtsProvider({ voicesDir: dir, executable: "piper", dataDir: dir, run });
  const request = { text: "hello", lang: "en", voice: "en_US-example-medium", rate: 1 };
  await expect(provider.synthesize({ ...request, voice: "../secret" })).rejects.toThrow(
    /voice not found/,
  );
  await expect(provider.synthesize({ ...request, lang: "hu" })).rejects.toThrow(/voice not found/);
  await expect(provider.synthesize({ ...request, rate: 0 })).rejects.toThrow(/rate/);
  expect(run).not.toHaveBeenCalled();
});

test("model changes invalidate cache and transient failures retry", async () => {
  const model = path.join(dir, "hu_HU-example-medium.onnx");
  writeFileSync(model, "model 1");
  writeFileSync(`${model}.json`, "{}");
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("ETIMEDOUT"))
    .mockResolvedValue(encodeWav(sineTone(440, 2400)));
  const provider = new PiperTtsProvider({
    voicesDir: dir,
    executable: "piper",
    dataDir: dir,
    run,
    initialBackoffMs: 1,
  });
  const request = { text: "Szia", lang: "hu", voice: "hu_HU-example-medium", rate: 1 };
  const first = await provider.synthesize(request);
  writeFileSync(model, "model 2");
  const second = await provider.synthesize(request);
  expect(first.wavPath).not.toBe(second.wavPath);
  expect(run).toHaveBeenCalledTimes(3);
});
