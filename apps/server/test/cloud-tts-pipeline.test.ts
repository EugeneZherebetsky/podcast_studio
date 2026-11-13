import { expect, test, vi } from "vitest";
import { generateJob } from "../src/pipeline/runner.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

test("cloud input limit checks the complete script before the first synthesis", async () => {
  const f = fakeGeneration();
  const synthesize = vi.fn(f.deps.providers.tts.synthesize.bind(f.deps.providers.tts));
  f.deps.providers.tts = { voices: async () => [], synthesize, forRun: () => ({ voices: async () => [], synthesize }) };
  try {
    await expect(generateJob({ ...f.deps, cloudTtsInputLimit: 120 }, f.jobId)).rejects.toThrow("Cloud TTS input limit exceeded");
    expect(synthesize).not.toHaveBeenCalled();
  } finally { f.close(); }
}, GENERATION_TIMEOUT_MS);
