import { expect, test } from "vitest";
import { parseConfig, SettingsSchema } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

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
