import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { createScriptSelection, chatGptDeadline } from "../src/chatgpt-selection.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";
import { episodes, jobs, usage } from "../src/db/schema.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS, respond } from "./generation-fakes.ts";

it("uses bounded configurable stage deadlines", () => {
  vi.stubEnv("CHATGPT_SCRIPT_TIMEOUT_MS", "300001");
  vi.stubEnv("CHATGPT_STAGE_TIMEOUT_MS", "180000");
  try {
    expect(chatGptDeadline("script")).toBe(300001);
    expect(chatGptDeadline("notes")).toBe(180000);
    vi.stubEnv("CHATGPT_SCRIPT_TIMEOUT_MS", "900001");
    expect(() => chatGptDeadline("script")).toThrow("Invalid ChatGPT stage timeout");
  } finally { vi.unstubAllEnvs(); }
});

it("treats an invalid stage timeout as preflight and leaves the recovery guard clean", async () => {
  const f = fakeGeneration();
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => "{}"),
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
  vi.stubEnv("CHATGPT_STAGE_TIMEOUT_MS", "invalid");
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    for (let i = 0; i < 500 && f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.error).toMatch(/invalid ChatGPT stage timeout/i);
    expect(session.generateStructured).not.toHaveBeenCalled();
    await runner.close();
    const guard = openDesktopGuard(f.dir);
    try { expect(() => guard.begin()).not.toThrow(); } finally { guard.close(true); }
  } finally { await runner.close(); vi.unstubAllEnvs(); f.close(); }
});

it("retries a failed job as new using all-stage ChatGPT, preserving old artifacts and exporting the new episode", async () => {
  const f = fakeGeneration({ review: true });
  f.db.update(jobs).set({ status: "failed", error: "old failure" }).where(eq(jobs.id, f.jobId)).run();
  const old = f.job();
  mkdirSync(f.workDir, { recursive: true });
  const oldArtifact = path.join(f.workDir, "old-artifact.txt");
  writeFileSync(oldArtifact, "preserve this");
  const calls: string[] = [];
  const prompts: string[] = [];
  let stage = "";
  const events = new EventEmitter();
  events.on("event", (event) => { if (event.status === "running") stage = event.stage; });
  const local = vi.spyOn(f.deps.providers.llm, "generateObject");
  const schemas: Record<string, string[][]> = {};
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    if (!init?.body) return Response.json({ models: [{ slug: "chosen", display_name: "Chosen", visibility: "list" }] });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "chosen", store: false, stream: true, text: { format: { type: "json_schema", strict: false, schema: { type: "object" } } } });
    const schema = body.text.format.schema;
    (schemas[stage] ??= []).push(Object.keys(schema.properties));
    calls.push(stage);
    const prompt: string = body.input[0].content;
    prompts.push(prompt);
    const output = respond({ slot: stage === "plan" || stage === "notes" ? "fast" : "main", system: body.instructions, prompt, schema: z.unknown() });
    return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(output) })}\n\ndata: {"type":"response.completed"}\n\n`);
  }));
  const session = await createChatGptSession(path.join(f.dir, "session"), async () => ({
    authorizationUrl: "https://example.test", close() {}, result: Promise.resolve({
      kind: "success" as const, subject: "sub", clientId: "client", accessToken: "access", idToken: "id", expiresIn: 60, scopes: [], planEnabled: true,
    }),
  }), async () => "revoked");
  await (await session.login("alice")).complete();
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
  expect(selection.get()).toMatchObject({ provider: "chatgpt", scope: "all-stages" });
  const runner = createDesktopRunner(f.deps, events, undefined, selection);
  const app = buildApp({ db: f.db, config: parseConfig({ DATA_DIR: f.dir }), events, runner });
  try {
    const response = await app.inject({ method: "POST", url: `/api/jobs/${f.jobId}/retry-as-new`, payload: {} });
    expect(response.statusCode).toBe(201);
    const job = response.json() as { id: string };
    expect(job.id).not.toBe(f.jobId);
    for (let i = 0; i < 1000; i++) {
      const row = f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
      if (row.status === "succeeded" || row.status === "failed") { expect(row.status, row.error ?? "").toBe("succeeded"); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("succeeded");
    expect(f.job()).toEqual(old);
    expect(readFileSync(oldArtifact, "utf8")).toBe("preserve this");
    expect(calls.filter((s) => s === "notes").length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls)).toEqual(new Set(["plan", "notes", "script", "review"]));
    expect(schemas.plan?.some((keys) => keys.includes("queries") && keys.includes("angle"))).toBe(true);
    expect(schemas.notes?.some((keys) => keys.includes("facts"))).toBe(true);
    expect(schemas.notes?.some((keys) => keys.includes("outline"))).toBe(true);
    expect(schemas.script?.some((keys) => keys.includes("segments"))).toBe(true);
    expect(schemas.review?.some((keys) => keys.includes("findings"))).toBe(true);
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
    const log = (await app.inject({ url: `/api/jobs/${job.id}/log` })).json();
    expect(log.available).toBe(true);
    expect(log.entries.map((entry: { message: string }) => entry.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Map 1\/\d+ completed/),
      expect.stringMatching(/^Merge completed/),
      expect.stringMatching(/^ChatGPT script: \d+ events, \d+ bytes received/),
    ]));
    for (const name of ["episode.json", "audio.m4a"]) {
      const response = await app.inject({ url: `/api/episodes/${job.id}/usb/${name}` });
      expect(response.statusCode).toBe(200);
      if (name === "episode.json") expect(response.json()).toEqual(metadata);
      else expect(response.rawPayload).toEqual(readFileSync(path.join(episode.path, name)));
    }
  } finally { await runner.close(); await app.close(); await session.shutdown(); vi.unstubAllGlobals(); f.close(); }
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


it.each(["not-json", "{}"])("keeps the queue moving after two settled invalid outputs: %s", async (output) => {
  const f = fakeGeneration();
  let calls = 0;
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: async () => { calls++; return output; },
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const request = { title: "Bees", brief: "", mode: "standard" as const, lang: "en", minutes: 1, review: false };
    const first = await runner.create(request);
    const second = await runner.create(request);
    for (let i = 0; i < 500 && calls < 4; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(4);
    expect(f.db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.error).toMatch(/invalid structured output/i);
    expect(f.db.select().from(jobs).where(eq(jobs.id, second.id)).get()?.error).not.toMatch(/manual recovery/i);
  } finally { await runner.close(); f.close(); }
});

it("captures job selection without a separate scope read", async () => {
  const f = fakeGeneration();
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => "{}"),
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
  const read = vi.spyOn(selection, "get").mockImplementation(() => { void selection.set({ provider: "local" }); return { provider: "chatgpt", account: "alice", model: "chosen", scope: "all-stages" }; });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false });
    await selection.set({ provider: "local" });
    for (let i = 0; i < 500; i++) {
      if (f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(read).not.toHaveBeenCalled();
    expect(session.generateStructured).not.toHaveBeenCalled();
    expect(f.llm.stages).not.toContain("plan");
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.error).toMatch(/selection changed/i);
  } finally { await runner.close(); f.close(); }
});


it("does not expand a queued local job when all-stage consent is selected later", async () => {
  const f = fakeGeneration();
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => "{}"),
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  const local = vi.spyOn(f.deps.providers.llm, "generateObject");
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: false });
    await selection.set({ provider: "chatgpt", model: "chosen", scope: "all-stages" });
    for (let i = 0; i < 1000 && !local.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(local).toHaveBeenCalled();
    expect(session.generateStructured).not.toHaveBeenCalled();
    if (["queued", "running"].includes(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status)) await runner.cancel(job.id);
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);
