import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createTtsProvider } from "../src/providers/index.ts";
import * as paths from "../src/paths.ts";
import { loadPrompt } from "../src/pipeline/prompts.ts";
import { openDatabase } from "../src/db/index.ts";
import { ensureMono24k16BitPcmWav } from "../src/providers/tts/cache.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { FakeTtsProvider } from "../src/providers/tts/fake.ts";
import { assembleAudio } from "../src/audio/assemble.ts";
import { buildApp } from "../src/app.ts";

afterEach(() => vi.unstubAllEnvs());

describe("desktop configuration root", () => {
  it("resolves data and Piper from the injected home rather than the repository", async () => {
    const home = makeTempDir();
    try {
      const voices = path.join(home, "piper", "voices");
      mkdirSync(voices, { recursive: true });
      writeFileSync(path.join(voices, "en_US-test.onnx"), "model");
      writeFileSync(path.join(voices, "en_US-test.onnx.json"), "{}");
      writeFileSync(
        path.join(home, ".env"),
        "PROFILE=local\nPIPER_DIR=piper\nDATA_DIR=from-file\n",
      );
      const config = loadConfig({
        env: {
          PODCAST_STUDIO_HOME: home,
          PROFILE: "local",
          PIPER_DIR: "piper",
          DATA_DIR: "my-data",
        },
      });
      expect(config.DATA_DIR).toBe(path.join(home, "my-data"));
      expect(loadConfig({ env: { PODCAST_STUDIO_HOME: home } }).DATA_DIR).toBe(
        path.join(home, "from-file"),
      );
      expect(await createTtsProvider(config).voices("en")).toHaveLength(1);
      const injected = loadConfig({
        rootDir: home,
        env: {
          PODCAST_STUDIO_HOME: path.join(home, "other"),
          PROFILE: "local",
          PIPER_DIR: "piper",
        },
      });
      expect(await createTtsProvider({ ...injected }).voices("en")).toHaveLength(1);
    } finally {
      removeTempDir(home);
    }
  });
});

describe("desktop resource paths", () => {
  it("defaults to the original locations and PATH executables", () => {
    vi.stubEnv("PODCAST_STUDIO_RESOURCES", "");
    vi.stubEnv("PODCAST_STUDIO_HOME", "");
    vi.stubEnv("FFMPEG_PATH", "");
    vi.stubEnv("FFPROBE_PATH", "");
    expect(paths.configRoot()).toBe(path.resolve(paths.REPO_ROOT));
    expect(paths.webRoot()).toBe(path.join(paths.REPO_ROOT, "apps", "web", "dist"));
    expect(paths.migrationsDir()).toBe(
      path.join(paths.REPO_ROOT, "apps", "server", "src", "db", "migrations"),
    );
    expect(paths.promptsDir()).toBe(
      path.join(paths.REPO_ROOT, "apps", "server", "src", "pipeline", "prompts"),
    );
    expect(paths.ffmpegPath()).toBe("ffmpeg");
    expect(paths.ffprobePath()).toBe("ffprobe");
  });

  it("redirects resource directories and binary overrides", () => {
    const resources = path.resolve("test-resources");
    vi.stubEnv("PODCAST_STUDIO_RESOURCES", resources);
    vi.stubEnv("FFMPEG_PATH", "custom ffmpeg");
    vi.stubEnv("FFPROBE_PATH", "custom ffprobe");
    expect(paths.webRoot()).toBe(path.join(resources, "web"));
    expect(paths.migrationsDir()).toBe(path.join(resources, "server", "migrations"));
    expect(paths.promptsDir()).toBe(path.join(resources, "server", "prompts"));
    expect(paths.ffmpegPath()).toBe("custom ffmpeg");
    expect(paths.ffprobePath()).toBe("custom ffprobe");
  });

  it("loads prompts and migrations from the redirected resource tree", async () => {
    const dir = makeTempDir();
    try {
      vi.stubEnv("PODCAST_STUDIO_RESOURCES", dir);
      mkdirSync(paths.promptsDir(), { recursive: true });
      writeFileSync(
        path.join(paths.promptsDir(), "plan.md"),
        "# System\ncustom system\n# User\ncustom user",
      );
      expect(loadPrompt("plan").system).toBe("custom system");
      expect(() => openDatabase(":memory:")).toThrow("_journal.json");
      cpSync(
        path.join(paths.REPO_ROOT, "apps", "server", "src", "db", "migrations"),
        paths.migrationsDir(),
        { recursive: true },
      );
      const db = openDatabase(":memory:");
      expect(
        db.$client.prepare("SELECT name FROM sqlite_master WHERE name = 'topics'").get(),
      ).toBeTruthy();
      mkdirSync(paths.webRoot(), { recursive: true });
      writeFileSync(path.join(paths.webRoot(), "index.html"), "desktop web root");
      const app = buildApp({ db, webRoot: paths.webRoot() });
      try {
        expect((await app.inject({ url: "/" })).body).toBe("desktop web root");
      } finally {
        await app.close();
      }
      db.$client.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it("uses the ffmpeg override for both audio normalization inputs", async () => {
    const dir = makeTempDir();
    try {
      const invalid = path.join(dir, "missing-ffmpeg");
      vi.stubEnv("FFMPEG_PATH", invalid);
      const input = path.join(dir, "input.bin");
      writeFileSync(input, "invalid audio");
      await expect(ensureMono24k16BitPcmWav(input, path.join(dir, "out.wav"))).rejects.toThrow(
        "missing-ffmpeg",
      );
      await expect(
        ensureMono24k16BitPcmWav(Buffer.from("invalid audio"), path.join(dir, "out.wav")),
      ).rejects.toThrow("missing-ffmpeg");
    } finally {
      removeTempDir(dir);
    }
  });

  it("uses the ffmpeg override when assembling audio", async () => {
    const dir = makeTempDir();
    try {
      vi.stubEnv("FFMPEG_PATH", path.join(dir, "missing-ffmpeg"));
      const tts = new FakeTtsProvider({ outDir: dir });
      const segment = {
        id: "s",
        kind: "content" as const,
        speaker: "host" as const,
        lang: "en",
        text: "hello",
        pauseAfterMs: 0,
      };
      const wav = await tts.synthesize({ text: segment.text, lang: "en", voice: "fake", rate: 1 });
      await expect(
        assembleAudio({
          segments: [segment],
          wavPaths: [wav.wavPath],
          chapters: [],
          outputPath: path.join(dir, "out.m4a"),
        }),
      ).rejects.toThrow("missing-ffmpeg");
    } finally {
      removeTempDir(dir);
    }
  });
});
