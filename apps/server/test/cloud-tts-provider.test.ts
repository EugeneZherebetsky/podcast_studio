import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { FakeTtsProvider } from "../src/providers/tts/fake.ts";
import { CloudTtsProvider } from "../src/providers/tts/cloud.ts";
import { encodeWav, isMono24k16BitPcmWav } from "../src/providers/tts/wav.ts";

test.each(["elevenlabs", "fish"] as const)("%s sends one safe request and writes validated WAV", async (provider) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cloud-tts-test-"));
  try {
    const request = { text: "Hello", lang: "en", voice: "voice-123", rate: 1 };
    const fake = new FakeTtsProvider({ outDir: dir });
    const audio = await readFile((await fake.synthesize(request)).wavPath);
    const fetcher = vi.fn(async () => new Response(audio, { status: 200 }));
    const tts = new CloudTtsProvider({ provider, model: provider === "fish" ? "s2.1-pro-free" : "eleven_multilingual_v2", apiKey: "test-key", fetcher }).forRun(path.join(dir, "run"));
    const result = await tts.synthesize(request);
    expect(isMono24k16BitPcmWav(await readFile(result.wavPath))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
    expect(url).toContain(provider === "fish" ? "api.fish.audio/v1/tts" : "api.elevenlabs.io/v1/text-to-speech/voice-123");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("Hello");
    if (provider === "fish") {
      expect(body.reference_id).toBe("voice-123");
      expect((init.headers as Record<string, string>).model).toBe("s2.1-pro-free");
      expect(body.prosody.speed).toBe(1);
    } else {
      expect(body.model_id).toBe("eleven_multilingual_v2");
      expect(body.voice_settings.speed).toBe(1);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider failures are sanitized and are not retried", async () => {
  const fetcher = vi.fn(async () => new Response("test-key private script", { status: 503 }));
  const tts = new CloudTtsProvider({ provider: "fish", model: "s2.1-pro-free", apiKey: "test-key", fetcher }).forRun(os.tmpdir());
  await expect(tts.synthesize({ text: "private script", lang: "en", voice: "voice-id", rate: 1 })).rejects.toThrow("Cloud TTS failed; the provider may have billed this request");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("rejects provider WAV with invalid byte rate before conversion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cloud-tts-bad-wav-"));
  try {
    const audio = encodeWav(Int16Array.from([1, 2]));
    audio.writeUInt32LE(1, 28);
    const fetcher = vi.fn(async () => new Response(audio));
    const tts = new CloudTtsProvider({ provider: "fish", model: "model", apiKey: "test-key", fetcher }).forRun(dir);
    await expect(tts.synthesize({ text: "Hello", lang: "en", voice: "voice-id", rate: 1 })).rejects.toThrow("Cloud TTS failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("converts provider MP3 to validated pipeline WAV", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cloud-tts-convert-"));
  try {
    const request = { text: "Hello", lang: "en", voice: "voice-id", rate: 1 };
    const fake = new FakeTtsProvider({ outDir: dir });
    const input = (await fake.synthesize(request)).wavPath;
    const mp3 = path.join(dir, "sample.mp3");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", input, mp3]);
    const audio = await readFile(mp3);
    const tts = new CloudTtsProvider({ provider: "elevenlabs", model: "eleven_multilingual_v2", apiKey: "test-key", fetcher: async () => new Response(audio) }).forRun(path.join(dir, "run"));
    expect(isMono24k16BitPcmWav(await readFile((await tts.synthesize(request)).wavPath))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cancellation aborts an in-flight request without retrying", async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const tts = new CloudTtsProvider({ provider: "fish", model: "s2.1-pro-free", apiKey: "test-key", fetcher }).forRun(os.tmpdir(), controller.signal);
  const result = tts.synthesize({ text: "Hello", lang: "en", voice: "voice-id", rate: 1 });
  controller.abort();
  await expect(result).rejects.toThrow("Cloud TTS failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
