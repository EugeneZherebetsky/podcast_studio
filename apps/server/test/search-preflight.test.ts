import { EventEmitter } from "node:events";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { fakeGeneration } from "./generation-fakes.ts";

test("unreachable search refuses the request before a job, model call or dirty marker", async () => {
  const f = fakeGeneration();
  const config = parseConfig({ PROFILE: "local", TTS_VOICE_NATIVE_HOST: "fixture" });
  const preflight = vi.fn(async () => { throw new Error("SearXNG is unreachable. Start local SearXNG and check its URL in Local services, then try again; see Setup for instructions."); });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), config, undefined, undefined, false, preflight);
  const app = buildApp({ db: f.db, config, runner });
  try {
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Bees", mode: "standard", lang: "en", minutes: 1, review: false } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Start local SearXNG");
    expect(preflight).toHaveBeenCalledOnce();
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
    expect(f.llm.stages).toEqual([]);
    const marker = new Database(path.join(f.dir, "desktop-generation-state.sqlite"), { readonly: true });
    try { expect(marker.prepare("select count(*) as n from state").get()).toMatchObject({ n: 0 }); }
    finally { marker.close(); }
    expect(f.db.$client.prepare("select count(*) as n from jobs where status = 'running'").get()).toMatchObject({ n: 0 });
  } finally { await app.close(); await runner.close(); f.close(); }
});

test("shutdown while preflight is pending cannot create a job afterward", async () => {
  const f = fakeGeneration();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, undefined, undefined, false, () => pending);
  try {
    const creating = runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    const result = expect(creating).rejects.toThrow("Runner is shutting down");
    await runner.close();
    finish();
    await result;
    expect(f.db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
    expect(f.llm.stages).toEqual([]);
  } finally { finish(); await runner.close(); f.close(); }
});
