import { EventEmitter } from "node:events";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

// Expected failure documents a real leak; remove .fails only when the security assertion passes.
test.fails("provider usage metadata must not enter SQLite with a synthetic credential", async () => {
  const dir = makeTempDir();
  const db = openDatabase(path.join(dir, "app.db"));
  const events = new EventEmitter();
  const emitted: unknown[] = [];
  events.on("event", (event) => emitted.push(event));
  const secret = "synthetic-generation-credential";
  const fake = createFakeProviders({ wavDir: path.join(dir, "wav") });
  const providers = { ...fake, llm: { async generateObject(): Promise<never> { throw Object.assign(new Error(secret), { usage: { provider: secret, model: "fake-fast", inputTokens: 1, outputTokens: 1, costUsd: 0 } }); } } };
  const runner = createDesktopRunner({ db, providers, dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, events);
  const config = parseConfig({ PROFILE: "local", DATA_DIR: dir });
  const app = buildApp({ db, config, runner, events });
  try {
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await vi.waitFor(() => expect(runner.isBusy!(id)).toBe(false));
    const stored = db.$client.prepare("select error from jobs where id = ?").get(id);
    const usage = db.$client.prepare("select provider from usage where job_id = ?").all(id);
    const stages = db.$client.prepare("select error from job_stages where job_id = ?").all(id);
    const response = await app.inject({ url: `/api/jobs/${id}` });
    const log = await app.inject({ url: `/api/jobs/${id}/log` });
    expect(response.json().error).toContain("External work may still be running");
    expect(JSON.stringify({ stored, usage, stages, emitted, response: response.body, log: log.body })).not.toContain(secret);
  } finally {
    await app.close();
    await runner.close();
    db.$client.close();
    removeTempDir(dir);
  }
});
