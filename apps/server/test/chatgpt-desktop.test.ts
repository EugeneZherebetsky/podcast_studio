import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createScriptSelection } from "../src/chatgpt-selection.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { episodes, jobs, jobStages } from "../src/db/schema.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

it("desktop runner uses the selected ChatGPT model and executes local review", async () => {
  const f = fakeGeneration();
  const output = {
    title: "Bees", summary: "About bees",
    chapters: [1, 2, 3].map((segmentIndex) => ({ title: `Chapter ${segmentIndex}`, segmentIndex })),
    segments: ["intro", "content", "content", "content", "recap", "outro"].map((kind) => ({
      kind, speaker: "host", lang: "en", text: Array(23).fill("bees").join(" "),
      ...(kind === "content" ? { sourceIds: ["s1"] } : {}),
    })),
  };
  const generateStructured = vi.fn(async (model: string) => model ? JSON.stringify(output) : "");
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }], generateStructured,
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
    for (let i = 0; i < 1000; i++) {
      const row = f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
      if (row.status === "succeeded" || row.status === "failed") { expect(row.status, row.error ?? "").toBe("succeeded"); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const episode = f.db.select().from(episodes).where(eq(episodes.id, job.id)).get()!;
    const metadata = JSON.parse(readFileSync(path.join(episode.path, "episode.json"), "utf8"));
    expect(metadata.generation.llm).toContain("ChatGPT script: chosen");
    expect(metadata.generation.llm).not.toContain("alice");
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured.mock.calls[0]?.[0]).toBe("chosen");
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("succeeded");
    expect(f.db.select().from(jobStages).all().find((row) => row.jobId === job.id && row.stage === "review")?.status).toBe("done");
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);


it("does not send a stale queued script and clears the durable guard after preflight failure", async () => {
  const f = fakeGeneration();
  const generateStructured = vi.fn(async () => "{}");
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }], generateStructured,
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen" });
  const events = new EventEmitter();
  events.on("event", (event) => {
    if (event.stage === "script" && event.status === "running") void selection.set({ provider: "local" });
  });
  const runner = createDesktopRunner(f.deps, events, undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
    for (let i = 0; i < 1000; i++) {
      const row = f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
      if (row.status === "failed") { expect(row.error).toMatch(/selection changed/i); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("failed");
    expect(generateStructured).not.toHaveBeenCalled();
    const next = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
    await runner.cancel(next.id);
    expect(await runner.close()).toBe(true);
    const reopened = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
    try {
      const third = await reopened.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
      await reopened.cancel(third.id);
    } finally { await reopened.close(); }
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);


it("clears the guard after a complete but invalid ChatGPT script", async () => {
  const f = fakeGeneration();
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => "{}"),
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
    for (let i = 0; i < 1000 && f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status !== "failed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("failed");
    expect(session.generateStructured).toHaveBeenCalledOnce();
    expect(await runner.close()).toBe(true);
    const reopened = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
    try {
      const next = await reopened.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
      await reopened.cancel(next.id);
    } finally { await reopened.close(); }
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);

it("aborts an in-flight ChatGPT request but retains the uncertain-work guard", async () => {
  const f = fakeGeneration();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let seenSignal: AbortSignal | undefined;
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: async (_model: string, _system: string, _prompt: string, _schema: object, signal?: AbortSignal) => {
      seenSignal = signal;
      started();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const selection = createScriptSelection(path.join(f.dir, "choice"), session);
  await selection.set({ provider: "chatgpt", model: "chosen" });
  const runner = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
  try {
    const job = await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true });
    await entered;
    await runner.cancel(job.id);
    expect(seenSignal?.aborted).toBe(true);
    expect(await runner.close()).toBe(true);
    const reopened = createDesktopRunner(f.deps, new EventEmitter(), undefined, selection);
    try {
      await expect(reopened.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1, review: true })).rejects.toThrow(/unclean/i);
    } finally { await reopened.close(); }
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);
