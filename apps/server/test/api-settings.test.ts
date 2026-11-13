import { expect, test } from "vitest";
import { parseConfig, SettingsSchema } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("cloud TTS status only reports key presence and stays local", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db, config: parseConfig({ PROFILE: "local", OPENAI_API_KEY: "example-secret" }) });
  try {
    const response = await app.inject({ url: "/api/settings/cloud-tts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ openaiConfigured: true, azureConfigured: false, elevenlabsConfigured: false, fishConfigured: false });
    expect(response.body).not.toContain("example-secret");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/api/settings/cloud-tts", headers: { host: "evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/settings/cloud-tts", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/settings/cloud-tts", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/settings/cloud-tts", remoteAddress: "192.0.2.2" })).statusCode).toBe(401);
  } finally {
    await app.close();
    db.$client.close();
  }
});

test("settings are validated, persisted and never reveal secrets", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db, config: parseConfig({ ANTHROPIC_API_KEY: "example-secret" }) });
  try {
    const initial = (await app.inject({ url: "/api/settings" })).json();
    SettingsSchema.parse(initial);
    expect(JSON.stringify(initial)).not.toContain("example-secret");
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { apiKey: "oops" } }))
        .statusCode,
    ).toBe(400);
    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { monthlyBudgetUsd: 7, voices: { huHost: "voice" } },
    });
    expect(updated.json().monthlyBudgetUsd).toBe(7);
    expect((await app.inject({ url: "/api/settings" })).json().voices.huHost).toBe("voice");
  } finally {
    await app.close();
    db.$client.close();
  }
});
