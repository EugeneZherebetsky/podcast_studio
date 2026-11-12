import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EpisodeSchema } from "shared";
import metadata from "../assets/episode.json";
import { sampleEpisode } from "./sample";
import { clampPosition, formatTime } from "./position";

describe("bundled episode", () => {
  it("parses using the shared schema and rejects invalid metadata", () => {
    expect(sampleEpisode).toEqual(EpisodeSchema.parse(metadata));
    expect(EpisodeSchema.safeParse({ ...metadata, schemaVersion: 999 }).success).toBe(false);
  });

  it("identifies the actual bundled audio and supports playback position", () => {
    const audio = readFileSync(new URL(`../assets/${sampleEpisode.audio.file}`, import.meta.url));
    expect(audio.byteLength).toBe(sampleEpisode.audio.bytes);
    expect(createHash("sha256").update(audio).digest("hex")).toBe(sampleEpisode.audio.sha256);
    const duration = sampleEpisode.durationMs / 1000;
    expect(formatTime(clampPosition(duration + 30, duration))).toBe("10:19");
    expect(clampPosition(-15, duration)).toBe(0);
  });
});
