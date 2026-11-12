import { describe, expect, it } from "vitest";
import { sampleEpisode } from "./sample";
import { saveOfflineEpisode } from "./offline-store";

describe("offline episode storage", () => {
  it("publishes only a verified package", async () => {
    const calls: string[] = [];
    const result = await saveOfflineEpisode(sampleEpisode, {
      stage: async () => { calls.push("stage"); return { bytes: sampleEpisode.audio.bytes, sha256: sampleEpisode.audio.sha256 }; },
      publish: async () => { calls.push("publish"); },
      discard: () => { calls.push("discard"); },
    });
    expect(result.id).toBe(sampleEpisode.id);
    expect(calls).toEqual(["stage", "publish"]);
  });

  it.each(["bytes", "sha256"] as const)("rejects a mismatched %s without publishing", async (field) => {
    const calls: string[] = [];
    await expect(saveOfflineEpisode(sampleEpisode, {
      stage: async () => ({ bytes: field === "bytes" ? 0 : sampleEpisode.audio.bytes, sha256: field === "sha256" ? "0".repeat(64) : sampleEpisode.audio.sha256 }),
      publish: async () => { calls.push("publish"); },
      discard: () => { calls.push("discard"); },
    })).rejects.toThrow("Audio verification failed");
    expect(calls).toEqual(["discard"]);
  });

  it("discards failed stages and never publishes invalid metadata", async () => {
    let discarded = 0;
    const io = { stage: async () => { throw new Error("failed"); }, publish: async () => {}, discard: () => { discarded++; } };
    await expect(saveOfflineEpisode(sampleEpisode, io)).rejects.toThrow("failed");
    expect(discarded).toBe(1);
    await expect(saveOfflineEpisode({ ...sampleEpisode, audio: { ...sampleEpisode.audio, sha256: "invalid" } }, io)).rejects.toThrow();
    expect(discarded).toBe(1);
  });
});
