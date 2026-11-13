import { expect, test } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("cloud speech settings persist without exposing credentials and reject invalid models", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db, config: parseConfig({ PROFILE: "local", FISH_AUDIO_API_KEY: "test-secret" }) });
  try {
    const settings = { provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 1000 };
    const result = await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: settings } });
    expect(result.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/settings" })).json().cloudTts).toEqual(settings);
    expect((await app.inject({ url: "/api/settings/cloud-tts" })).json().fishConfigured).toBe(true);
    expect(result.body).not.toContain("test-secret");
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: { cloudTts: { ...settings, model: "bogus" } } })).statusCode).toBe(400);
  } finally { await app.close(); db.$client.close(); }
});
