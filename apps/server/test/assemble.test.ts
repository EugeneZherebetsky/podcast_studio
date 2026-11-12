import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeTtsProvider } from "../src/providers/tts/fake.ts";
import { assembleAudio } from "../src/audio/assemble.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("assembles fake speech with sample-accurate timings and embedded chapters", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "podcast-assemble-"));
  dirs.push(dir);
  const texts = ["aaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccc"];
  const frequencies = [400, 800, 1200];
  const tts = new FakeTtsProvider({
    outDir: dir,
    msPerChar: 100,
    frequencyHz: (r) => frequencies[texts.indexOf(r.text)]!,
  });
  const segments = texts.map((text, i) => ({
    id: `s${i}`,
    kind: "content" as const,
    speaker: "host" as const,
    lang: "en",
    text,
    pauseAfterMs: [240, 0, 300][i]!,
  }));
  const wavPaths = await Promise.all(
    segments.map(
      async (s) =>
        (await tts.synthesize({ text: s.text, lang: s.lang, voice: "fake", rate: 1 })).wavPath,
    ),
  );
  const outputPath = path.join(dir, "audio.m4a");
  const result = await assembleAudio({
    segments,
    wavPaths,
    chapters: [
      { title: "First", segmentIndex: 0 },
      { title: "Second", segmentIndex: 2 },
    ],
    outputPath,
  });
  expect(result.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
    [0, 1200],
    [1440, 3040],
    [3040, 4440],
  ]);
  expect(result.durationMs).toBe(4740);
  const loudness = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      outputPath,
      "-af",
      "loudnorm=I=-16:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  expect(loudness.status).toBe(0);
  const measured = /"input_i"\s*:\s*"([^"]+)"/.exec(loudness.stderr);
  expect(measured).not.toBeNull();
  expect(Math.abs(Number(measured![1]) + 16)).toBeLessThan(1);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_frames", "-show_chapters", "-of", "json", outputPath],
      { encoding: "utf8" },
    ),
  ) as {
    streams: { codec_name: string; channels?: number; sample_rate?: string }[];
    frames: { pts_time?: string; nb_samples?: number }[];
    chapters: { start_time: string; tags: { title: string } }[];
  };
  expect(probe.streams[0]).toMatchObject({ codec_name: "aac", channels: 1, sample_rate: "24000" });
  expect(probe.chapters.map((c) => c.tags.title)).toEqual(["First", "Second"]);
  expect(Number(probe.chapters[1]!.start_time) * 1000).toBeCloseTo(result.segments[2]!.startMs, 0);
  const pcm = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      outputPath,
      "-map",
      "0:a:0",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    { maxBuffer: 10_000_000 },
  );
  const firstPts = Number(probe.frames.find((f) => f.nb_samples)?.pts_time);
  expect(Number.isFinite(firstPts)).toBe(true);
  const window = 240;
  const found = frequencies.map(() => [] as number[]);
  for (let offset = 0; offset + window * 2 <= pcm.length; offset += window * 2) {
    const powers = frequencies.map((frequency) => {
      let re = 0,
        im = 0;
      for (let i = 0; i < window; i++) {
        const sample = pcm.readInt16LE(offset + 2 * i);
        const phase = (2 * Math.PI * frequency * i) / 24000;
        re += sample * Math.cos(phase);
        im += sample * Math.sin(phase);
      }
      return Math.hypot(re, im) / window;
    });
    const max = Math.max(...powers);
    if (max > 500) found[powers.indexOf(max)]!.push(firstPts * 1000 + offset / 2 / 24);
  }
  found.forEach((positions, i) => {
    expect(positions.length).toBeGreaterThan(0);
    expect(Math.abs(result.segments[i]!.startMs - positions[0]!)).toBeLessThanOrEqual(80);
    expect(Math.abs(result.segments[i]!.endMs - (positions.at(-1)! + 10))).toBeLessThanOrEqual(80);
  });
});
