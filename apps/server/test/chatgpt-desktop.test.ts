import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createScriptSelection } from "../src/chatgpt-selection.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { jobs, jobStages } from "../src/db/schema.ts";
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
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured.mock.calls[0]?.[0]).toBe("chosen");
    expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("succeeded");
    expect(f.db.select().from(jobStages).all().find((row) => row.jobId === job.id && row.stage === "review")?.status).toBe("done");
  } finally { await runner.close(); f.close(); }
}, GENERATION_TIMEOUT_MS);
