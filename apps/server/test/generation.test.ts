import path from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/index.ts";
import { episodes, jobs } from "../src/db/schema.ts";
import { createJob, generateJob } from "../src/pipeline/runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import type { FakeLlmCall } from "../src/providers/llm/fake.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

function respond(call: FakeLlmCall): unknown {
  const id = /<source id="(s\d+)">/.exec(call.prompt)?.[1];
  if (id) return { facts: [`Fact from ${id}`] };
  if (call.prompt.includes("<facts>"))
    return { outline: [{ heading: "Facts", facts: [{ text: "A fact", sourceIds: ["s1"] }] }] };
  if (call.slot === "fast")
    return { queries: ["one", "two", "three", "four", "five"], angle: "Bees" };
  const kinds = ["intro", "content", "content", "content", "recap", "outro"];
  return {
    title: "Bees",
    summary: "About bees",
    chapters: [1, 2, 3].map((segmentIndex) => ({ title: `Chapter ${segmentIndex}`, segmentIndex })),
    segments: kinds.map((kind) => ({
      kind,
      speaker: "host",
      lang: "en",
      text: Array(23).fill("bees").join(" "),
      ...(kind === "content" ? { sourceIds: ["s1"] } : {}),
    })),
  };
}

test("a fresh job publishes playable audio", async () => {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  try {
    const providers = createFakeProviders({ wavDir: path.join(dir, "wav") });
    providers.llm.enqueue(...Array.from({ length: 30 }, () => respond));
    const job = createJob(
      db,
      { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false },
      20,
    );
    const deps = {
      db,
      providers,
      dataDir: dir,
      budgetUsd: 20,
      voice: "fake",
      profile: "local",
      llmName: "fake",
      ttsName: "fake",
      nativeLang: "en",
    };
    await generateJob(deps, job.id);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe("succeeded");
    const episode = db.select().from(episodes).get()!;
    expect(
      JSON.parse(readFileSync(path.join(episode.path, "episode.json"), "utf8")).segments,
    ).toHaveLength(6);
    expect(readFileSync(path.join(episode.path, "audio.m4a")).length).toBeGreaterThan(0);
  } finally {
    db.$client.close();
    removeTempDir(dir);
  }
});
