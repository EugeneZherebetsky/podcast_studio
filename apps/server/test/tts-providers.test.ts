import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AzureTtsProvider,
  computeTtsCacheKey,
  isMono24k16BitPcmWav,
  OpenAiTtsProvider,
} from "../src/providers/index.ts";
import { encodeWav, sineTone } from "../src/providers/tts/wav.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  removeTempDir(tempDir);
});

function valid24kWav(): Buffer {
  return encodeWav(sineTone(440, 2400));
}

function make44kStereoWav(): Buffer {
  const sampleRate = 44100;
  const channels = 2;
  const bitsPerSample = 16;
  const samples = 4410;
  const dataBytes = samples * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

describe("AzureTtsProvider", () => {
  test("constructs valid SSML, headers, and request to Azure REST endpoint", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedOptions = init;
      return new Response(valid24kWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      region: "eastus",
      dataDir: tempDir,
      fetch: mockFetch,
    });

    const result = await provider.synthesize({
      text: "Hello & welcome <world>! Let's check \"quotes\".",
      lang: "en-US",
      voice: "en-US-JennyNeural",
      rate: 0.95,
    });

    expect(capturedUrl).toBe(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
    );
    expect(capturedOptions?.method).toBe("POST");
    expect(capturedOptions?.headers).toMatchObject({
      "Ocp-Apim-Subscription-Key": "az-secret-123",
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
      "User-Agent": "podcast-studio",
    });

    const body = String(capturedOptions?.body);
    expect(body).toBe(
      '<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural"><prosody rate="0.95">Hello &amp; welcome &lt;world&gt;! Let&apos;s check &quot;quotes&quot;.</prosody></voice></speak>',
    );

    expect(existsSync(result.wavPath)).toBe(true);
    expect(isMono24k16BitPcmWav(readFileSync(result.wavPath))).toBe(true);
    expect(result.chars).toBe(
      Array.from("Hello & welcome <world>! Let's check \"quotes\".").length,
    );
  });

  test("voices(lang) queries Azure endpoint and filters by language", async () => {
    const mockVoices = [
      {
        ShortName: "hu-HU-NoemiNeural",
        DisplayName: "Noémi",
        Locale: "hu-HU",
        Gender: "Female",
      },
      {
        ShortName: "hu-HU-TamasNeural",
        DisplayName: "Tamás",
        Locale: "hu-HU",
        Gender: "Male",
      },
      {
        ShortName: "en-US-JennyNeural",
        DisplayName: "Jenny",
        Locale: "en-US",
        Gender: "Female",
      },
    ];

    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify(mockVoices), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      fetch: mockFetch,
    });

    const huVoices = await provider.voices("hu");
    expect(huVoices).toEqual([
      {
        id: "hu-HU-NoemiNeural",
        name: "Noémi",
        lang: "hu-HU",
        gender: "female",
      },
      {
        id: "hu-HU-TamasNeural",
        name: "Tamás",
        lang: "hu-HU",
        gender: "male",
      },
    ]);

    const enVoices = await provider.voices("en");
    expect(enVoices).toEqual([
      {
        id: "en-US-JennyNeural",
        name: "Jenny",
        lang: "en-US",
        gender: "female",
      },
    ]);
  });

  test("voices(lang) falls back to known voices when voices endpoint is unreachable", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Network error");
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      fetch: mockFetch,
    });

    const huVoices = await provider.voices("hu");
    expect(huVoices.length).toBeGreaterThan(0);
    expect(huVoices.some((v) => v.id === "hu-HU-NoemiNeural")).toBe(true);
  });
});

describe("OpenAiTtsProvider", () => {
  test("constructs valid request to OpenAI speech endpoint", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedOptions = init;
      return new Response(valid24kWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const provider = new OpenAiTtsProvider({
      apiKey: "oai-secret-456",
      dataDir: tempDir,
      fetch: mockFetch,
    });

    const result = await provider.synthesize({
      text: "Testing OpenAI TTS",
      lang: "en",
      voice: "alloy",
      rate: 1.05,
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/speech");
    expect(capturedOptions?.method).toBe("POST");
    expect(capturedOptions?.headers).toMatchObject({
      Authorization: "Bearer oai-secret-456",
      "Content-Type": "application/json",
      "User-Agent": "podcast-studio",
    });

    const body = JSON.parse(String(capturedOptions?.body));
    expect(body).toEqual({
      model: "tts-1",
      input: "Testing OpenAI TTS",
      voice: "alloy",
      speed: 1.05,
      response_format: "wav",
    });

    expect(existsSync(result.wavPath)).toBe(true);
    expect(result.chars).toBe("Testing OpenAI TTS".length);
  });

  test("voices(lang) returns OpenAI voices with target language", async () => {
    const provider = new OpenAiTtsProvider({
      apiKey: "oai-secret-456",
    });

    const huVoices = await provider.voices("hu");
    expect(huVoices.some((v) => v.id === "alloy" && v.lang === "hu")).toBe(true);
    expect(huVoices.some((v) => v.id === "nova" && v.gender === "female")).toBe(true);
  });
});

describe("Audio caching", () => {
  test("cache hit avoids second mock fetch call and returns cached WAV", async () => {
    let callCount = 0;
    const mockFetch = vi.fn<typeof fetch>(async () => {
      callCount++;
      return new Response(valid24kWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      dataDir: tempDir,
      fetch: mockFetch,
    });

    const req = {
      text: "Caching test message",
      lang: "hu",
      voice: "hu-HU-NoemiNeural",
      rate: 1.0,
    };

    // First call: cache miss, calls fetch
    const firstResult = await provider.synthesize(req);
    expect(callCount).toBe(1);
    expect(existsSync(firstResult.wavPath)).toBe(true);

    const expectedKey = computeTtsCacheKey("azure", req);
    expect(path.basename(firstResult.wavPath)).toBe(expectedKey);

    // Second call with identical parameters: cache hit, avoids fetch
    const secondResult = await provider.synthesize(req);
    expect(callCount).toBe(1);
    expect(secondResult.wavPath).toBe(firstResult.wavPath);
    expect(secondResult.chars).toBe(firstResult.chars);

    // Call with different text: cache miss, calls fetch
    await provider.synthesize({ ...req, text: "Different text" });
    expect(callCount).toBe(2);
  });
});

describe("Concurrency limit and retry", () => {
  test("concurrency limit respects max 3 concurrent synthesis requests", async () => {
    let activeRequests = 0;
    let maxObservedActive = 0;

    const mockFetch = vi.fn<typeof fetch>(async () => {
      activeRequests++;
      maxObservedActive = Math.max(maxObservedActive, activeRequests);
      // Simulate synthesis delay
      await new Promise((resolve) => setTimeout(resolve, 40));
      activeRequests--;
      return new Response(valid24kWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      dataDir: tempDir,
      fetch: mockFetch,
      concurrencyLimit: 3,
    });

    // Launch 6 distinct requests concurrently
    const promises = Array.from({ length: 6 }, (_, i) =>
      provider.synthesize({
        text: `Concurrency item ${i}`,
        lang: "en",
        voice: "en-US-JennyNeural",
        rate: 1.0,
      }),
    );

    await Promise.all(promises);

    expect(maxObservedActive).toBeLessThanOrEqual(3);
    expect(maxObservedActive).toBeGreaterThan(1);
  });

  test("retries transient HTTP 429 and 500 errors with backoff", async () => {
    let attempts = 0;
    const mockFetch = vi.fn<typeof fetch>(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (attempts === 2) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(valid24kWav(), { status: 200 });
    });

    const provider = new OpenAiTtsProvider({
      apiKey: "oai-secret-456",
      dataDir: tempDir,
      fetch: mockFetch,
      initialBackoffMs: 1, // Fast for testing
    });

    const result = await provider.synthesize({
      text: "Retry test",
      lang: "en",
      voice: "alloy",
      rate: 1.0,
    });

    expect(attempts).toBe(3);
    expect(existsSync(result.wavPath)).toBe(true);
  });

  test("does not retry client errors (HTTP 400 or 401)", async () => {
    let attempts = 0;
    const mockFetch = vi.fn<typeof fetch>(async () => {
      attempts++;
      return new Response("Unauthorized", { status: 401 });
    });

    const provider = new AzureTtsProvider({
      subscriptionKey: "az-secret-123",
      dataDir: tempDir,
      fetch: mockFetch,
      initialBackoffMs: 1,
    });

    await expect(
      provider.synthesize({
        text: "Unauthorized test",
        lang: "en",
        voice: "en-US-JennyNeural",
        rate: 1.0,
      }),
    ).rejects.toThrowError(/401/);

    expect(attempts).toBe(1);
  });
});

describe("Audio normalisation with ffmpeg", () => {
  test("converts non-24kHz stereo audio to mono 24 kHz 16-bit PCM WAV", async () => {
    const stereoWav = make44kStereoWav();
    expect(isMono24k16BitPcmWav(stereoWav)).toBe(false);

    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(stereoWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const provider = new OpenAiTtsProvider({
      apiKey: "oai-secret-456",
      dataDir: tempDir,
      fetch: mockFetch,
    });

    const result = await provider.synthesize({
      text: "Normalisation test",
      lang: "en",
      voice: "alloy",
      rate: 1.0,
    });

    expect(existsSync(result.wavPath)).toBe(true);
    const outputBuffer = readFileSync(result.wavPath);
    expect(isMono24k16BitPcmWav(outputBuffer)).toBe(true);
  });
});
