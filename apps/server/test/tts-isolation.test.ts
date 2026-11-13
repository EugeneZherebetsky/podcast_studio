import path from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TtsCache } from "../src/providers/tts/cache.ts";
import { encodeWav, sineTone } from "../src/providers/tts/wav.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("concurrent cache writers never replace the first complete entry", async () => {
  const dir = makeTempDir();
  try {
    const cache = new TtsCache({ cacheDir: dir });
    const req = { text: "hello", voice: "v", lang: "en", rate: 1 };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstAudio = encodeWav(sineTone(440, 100));
    const lateAudio = encodeWav(sineTone(880, 100));
    const late = cache.synthesizeWithCache("test", req, async () => {
      entered();
      await gate;
      return { audio: lateAudio };
    });
    await blocked;
    const first = await cache.synthesizeWithCache("test", req, async () => ({ audio: firstAudio }));
    release();
    await late;
    expect(readFileSync(first.wavPath)).toEqual(firstAudio);
    expect(path.dirname(first.wavPath)).toBe(dir);
  } finally {
    removeTempDir(dir);
  }
});
