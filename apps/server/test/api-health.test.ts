import { expect, test } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("health reports injected provider reachability without secrets", async () => {
  const db = openDatabase(":memory:");
  const health = {
    llm: { name: "fake-llm", reachable: true },
    search: { name: "fake-search", reachable: false },
    tts: { name: "fake-tts", reachable: true },
  };
  const app = buildApp({
    db,
    config: parseConfig({ ANTHROPIC_API_KEY: "secret" }),
    providerHealth: async () => health,
  });
  try {
    const response = await app.inject({ url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "0.0.0", profile: "cloud", providers: health });
    expect(response.body).not.toContain("secret");
  } finally {
    await app.close();
    db.$client.close();
  }
});

test("health does not invent reachability when checks are unavailable", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db, config: parseConfig({}) });
  try {
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(503);
  } finally {
    await app.close();
    db.$client.close();
  }
});
