import { expect, test } from "vitest";
import { openDatabase } from "../src/db/index.ts";
import { usage } from "../src/db/schema.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import { createSettingsData } from "../src/settings-data.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("settings data uses the injected provider and recorded UTC monthly cost", async () => {
  const db = openDatabase(":memory:");
  const dir = makeTempDir();
  const tts = createFakeProviders({ wavDir: dir }).tts;
  const settings = createSettingsData(db, tts);
  try {
    expect(settings.usage(new Date("2026-11-12T00:00:00Z"))).toBe(0);
    db.insert(usage).values([
      { ts: "2026-11-01T00:00:00.000Z", provider: "example", kind: "llm", units: 1, costUsd: 0.125 },
      { ts: "2026-12-01T00:00:00.000Z", provider: "example", kind: "tts", units: 1, costUsd: 2 },
    ]).run();
    expect(settings.usage(new Date("2026-11-12T00:00:00Z"))).toBe(0.125);
    const voices = await settings.voices("hu");
    expect(voices.length).toBeGreaterThan(0);
    const audio = await settings.preview({ text: "Szia!", lang: "hu", voice: voices[0]!.id, rate: 1 });
    expect(audio.subarray(0, 4).toString()).toBe("RIFF");
  } finally {
    db.$client.close();
    removeTempDir(dir);
  }
});
