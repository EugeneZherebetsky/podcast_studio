import { afterEach, expect, test, vi } from "vitest";
import { api } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

test("reports API errors and validates successful responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Job runner unavailable" }), { status: 503 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: "wrong" }))),
  );
  await expect(
    api.createJob({ title: "A", brief: "", mode: "standard", lang: "en", minutes: 5 }),
  ).rejects.toThrow("Job runner unavailable");
  await expect(api.jobs()).rejects.toThrow();
});

test("encodes episode identifiers", () => {
  expect(api.audioUrl("a/b")).toBe("/api/episodes/a%2Fb/audio");
});
