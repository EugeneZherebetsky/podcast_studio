import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Chapter, EpisodeSegment, ScriptSegment } from "shared";
import { WAV_SAMPLE_RATE } from "../providers/tts/wav.ts";

interface AssembleInput {
  segments: ScriptSegment[];
  wavPaths: string[];
  chapters: { title: string; segmentIndex: number }[];
  outputPath: string;
}

function pcmData(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw new Error("Invalid WAV header");
  let format = false;
  let data: Buffer | undefined;
  for (let pos = 12; pos + 8 <= wav.length;) {
    const id = wav.toString("ascii", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV chunk");
    if (id === "fmt ") {
      if (
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== WAV_SAMPLE_RATE ||
        wav.readUInt16LE(start + 14) !== 16 ||
        wav.readUInt16LE(start + 12) !== 2
      )
        throw new Error("Expected mono 24 kHz 16-bit PCM WAV");
      format = true;
    }
    if (id === "data") {
      if (data || size === 0 || size % 2) throw new Error("Invalid WAV data");
      data = wav.subarray(start, start + size);
    }
    pos = start + size + (size % 2);
  }
  if (!format || !data) throw new Error("Missing WAV format or data");
  return data;
}

function escapeMetadata(value: string): string {
  return value.replace(/[\\=;#\n\r]/g, (c) => `\\${c}`);
}

export async function assembleAudio(
  input: AssembleInput,
): Promise<{ segments: EpisodeSegment[]; chapters: Chapter[]; durationMs: number }> {
  if (!input.segments.length || input.segments.length !== input.wavPaths.length)
    throw new Error("Expected one WAV per segment");
  let samples = 0;
  const chunks: Buffer[] = [];
  const segments: EpisodeSegment[] = [];
  for (let i = 0; i < input.segments.length; i++) {
    const segment = input.segments[i]!;
    const pcm = pcmData(await readFile(input.wavPaths[i]!));
    const startMs = Math.round((samples * 1000) / WAV_SAMPLE_RATE);
    samples += pcm.length / 2;
    const endMs = Math.round((samples * 1000) / WAV_SAMPLE_RATE);
    const pause = segment.pauseAfterMs ?? 0;
    if (!Number.isSafeInteger(pause) || pause < 0) throw new Error("Invalid pause");
    const silenceSamples = Math.round((pause * WAV_SAMPLE_RATE) / 1000);
    chunks.push(pcm, Buffer.alloc(silenceSamples * 2));
    samples += silenceSamples;
    segments.push({ ...segment, startMs, endMs });
  }
  const durationMs = Math.round((samples * 1000) / WAV_SAMPLE_RATE);
  let previous = -1;
  const chapters = input.chapters.map(({ title, segmentIndex }) => {
    if (
      !title ||
      !Number.isInteger(segmentIndex) ||
      segmentIndex <= previous ||
      segmentIndex >= segments.length
    )
      throw new Error("Invalid chapter");
    previous = segmentIndex;
    return { title, startMs: segments[segmentIndex]!.startMs };
  });
  const metadata = `;FFMETADATA1\n${chapters.map((c, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.startMs}\nEND=${chapters[i + 1]?.startMs ?? durationMs}\ntitle=${escapeMetadata(c.title)}\n`).join("")}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(WAV_SAMPLE_RATE),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-f",
        "ffmetadata",
        "-i",
        "pipe:3",
        "-map",
        "0:a:0",
        "-map_metadata",
        "1",
        "-map_chapters",
        "1",
        "-af",
        "loudnorm=I=-16:TP=-2:LRA=7",
        "-ar",
        String(WAV_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-f",
        "ipod",
        input.outputPath,
      ],
      { stdio: ["pipe", "ignore", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (part: string) => {
      error += part;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${error}`)),
    );
    child.stdin!.on("error", () => {});
    const meta = child.stdio[3];
    if (!meta || !("end" in meta)) {
      reject(new Error("Unable to write chapter metadata"));
      return;
    }
    meta.on("error", () => {});
    meta.end(metadata);
    child.stdin!.end(Buffer.concat(chunks));
  });
  return { segments, chapters, durationMs };
}
