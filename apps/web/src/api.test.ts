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

test("topic mutations encode ids and use the correct methods", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  await api.deleteTopic("a/b");
  expect(fetchMock).toHaveBeenCalledWith("/api/topics/a%2Fb", { method: "DELETE" });
});

test("settings reject unexpected secret fields in responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          profile: "cloud",
          nativeLang: "en",
          targetLang: "hu",
          level: "A1",
          monthlyBudgetUsd: 1,
          voices: { huHost: null, huCohost: null, nativeHost: null, nativeTeacher: null },
          secret: "not-for-client",
        }),
      ),
    ),
  );
  await expect(api.settings()).rejects.toThrow();
});

test("encodes episode identifiers", () => {
  expect(api.audioUrl("a/b")).toBe("/api/episodes/a%2Fb/audio");
});
