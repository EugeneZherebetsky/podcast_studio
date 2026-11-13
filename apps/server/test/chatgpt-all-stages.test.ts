import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import path from "node:path";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createScriptSelection } from "../src/chatgpt-selection.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { episodes, jobs, usage } from "../src/db/schema.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS, respond } from "./generation-fakes.ts";

it("routes plan, notes map and merge, script and review through the selected ChatGPT model", async () => {
  const f = fakeGeneration();
  const calls: string[] = [];
  const prompts: string[] = [];
  let stage = "";
  const events = new EventEmitter();
  events.on("event", (event) => { if (event.status === "running") stage = event.stage; });
  const local = vi.spyOn(f.deps.providers.llm, "generateObject");
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async (model: string, system: string, prompt: string) => {
      expect(model).toBe("chosen");
      calls.push(stage);
      prompts.push(prompt);
      return JSON.stringify(respond({ slot: stage === "plan" || stage === "notes" ? "fast" : "main", system, prompt, schema: z.unknown() }));
    }),
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
  expect(selection.get()).toMatchObject({ provider: "chatgpt", scope: "all-stages" });
  const runner = createDesktopRunner(f.deps, events, undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
    for (let i = 0; i < 1000; i++) {
      const row = f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
      if (row.status === "succeeded" || row.status === "failed") { expect(row.status, row.error ?? "").toBe("succeeded"); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("succeeded");
    expect(calls.filter((s) => s === "notes").length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls)).toEqual(new Set(["plan", "notes", "script", "review"]));
    expect(prompts.some((prompt) => prompt.includes('<source id="s1">'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("[s1] Fact from s1"))).toBe(true);
    expect(local).not.toHaveBeenCalled();
    expect(f.db.select().from(usage).all().filter((row) => row.provider === "chatgpt")).toEqual([]);
    const episode = f.db.select().from(episodes).where(eq(episodes.id, job.id)).get()!;
    const metadata = JSON.parse(readFileSync(path.join(episode.path, "episode.json"), "utf8"));
    expect(metadata.generation.llm).toContain("ChatGPT: chosen");
    expect(metadata.generation.llm).toContain("usage unavailable");
    expect(metadata.generation.llm).toContain("costUsd 0 is a placeholder");
    expect(metadata.generation.costUsd).toBe(0);
    expect(metadata.generation.llm).not.toContain("alice");
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

it("fails closed on expiry, cancellation and local opt-out for all-stage calls", async () => {
  const f = fakeGeneration();
  let expired = false;
  const session = {
    status: () => ({ active: "alice", expired, planEnabled: !expired, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => '{"ok":true}'),
  };
  try {
    const selection = createScriptSelection(path.join(f.dir, "choice"), session);
    await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
    const controller = new AbortController();
    const provider = selection.provider()!.create(controller.signal);
    const request = { slot: "fast" as const, system: "", prompt: "", schema: z.object({ ok: z.boolean() }) };
    expired = true;
    await expect(provider.generateObject(request)).rejects.toThrow(/sign|expired/i);
    expired = false;
    controller.abort();
    await expect(provider.generateObject(request)).rejects.toThrow();
    const activeProvider = selection.provider()!.create();
    await selection.set({ provider: "local" });
    await expect(activeProvider.generateObject(request)).rejects.toThrow(/selection changed/i);
    expect(selection.provider()).toBeUndefined();
    expect(session.generateStructured).not.toHaveBeenCalled();
    await selection.set({ provider: "chatgpt", model: "chosen" });
    expect(selection.generator()).toBeDefined();
    expect(() => selection.provider()).toThrow(/privacy notice/i);
  } finally { f.close(); }
});
