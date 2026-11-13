import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { episodes, jobs } from "../db/schema.ts";
import { hashInputs } from "./artifacts.ts";
import { parseManualDraft, prepareManualDraft } from "./manual-draft.ts";
import { NotesSchema, PlanSchema, SourcesSchema, outlineResponseSchemaFor } from "./schemas.ts";
import type { ScriptInput } from "./script.ts";

async function claimed<T>(
  db: Db,
  id: string,
  action: (job: typeof jobs.$inferSelect) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const job = db.transaction((tx) => {
    const current = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!current) throw new Error("Job not found");
    if (current.status !== "queued" && current.status !== "failed")
      throw new Error("Job must be queued or failed");
    if (current.options.mode !== "standard") throw new Error("Only standard mode is supported");
    if (tx.select().from(episodes).where(eq(episodes.id, id)).get())
      throw new Error("Job already published");
    tx.update(jobs)
      .set({ status: "running", ownerToken: token, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
    return current;
  });
  try {
    const result = await action(job);
    db.transaction((tx) => {
      const current = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (
        !current ||
        current.status !== "running" ||
        current.ownerToken !== token ||
        tx.select().from(episodes).where(eq(episodes.id, id)).get()
      )
        throw new Error("Job ownership lost or episode published");
      tx.update(jobs)
        .set({ status: job.status, ownerToken: null, updatedAt: new Date().toISOString() })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.ownerToken, token)))
        .run();
    });
    return result;
  } finally {
    db.update(jobs)
      .set({ status: job.status, ownerToken: null, updatedAt: new Date().toISOString() })
      .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.ownerToken, token)))
      .run();
  }
}

async function loadInput(work: string, lang: ScriptInput["lang"]): Promise<ScriptInput> {
  const load = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(work, `${name}.json`), "utf8"));
  const plan = PlanSchema.parse(await load("plan"));
  const notes = NotesSchema.parse(await load("notes"));
  const sources = SourcesSchema.parse(await load("sources"));
  const ids = new Set(sources.sources.map((s) => s.id));
  if (ids.size !== sources.sources.length || notes.facts.some((f) => !ids.has(f.sourceId)))
    throw new Error("Invalid source IDs in research notes");
  outlineResponseSchemaFor(ids).parse(notes);
  return { plan, notes, sources, lang, mode: "standard" };
}

export async function manualPrepare(db: Db, dataDir: string, id: string): Promise<string> {
  return claimed(db, id, async (job) => {
    const input = await loadInput(path.join(dataDir, "jobs", id), job.options.lang);
    const prepared = prepareManualDraft(input);
    const dir = path.join(dataDir, "jobs", id, "manual", randomUUID());
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "input.json"),
      JSON.stringify({ jobId: id, input, hash: hashInputs(input) }, null, 2),
      { flag: "wx" },
    );
    await writeFile(
      path.join(dir, "prompt.txt"),
      `${prepared.warning}\n\n${prepared.prompt}\n\nReturn JSON matching this schema:\n${JSON.stringify(prepared.schema, null, 2)}\n`,
      { flag: "wx" },
    );
    return dir;
  });
}

export async function manualImport(
  db: Db,
  dataDir: string,
  id: string,
  preparedDir: string,
  text: string,
): Promise<string> {
  return claimed(db, id, async (job) => {
    const root = path.resolve(dataDir, "jobs", id, "manual");
    const prepared = path.resolve(preparedDir);
    if (path.dirname(prepared) !== root || !/^[0-9a-f-]{36}$/u.test(path.basename(prepared)))
      throw new Error("Invalid preparation directory");
    const stored: unknown = JSON.parse(await readFile(path.join(prepared, "input.json"), "utf8"));
    if (
      !stored ||
      typeof stored !== "object" ||
      !("input" in stored) ||
      !("hash" in stored) ||
      !("jobId" in stored) ||
      stored.jobId !== id ||
      stored.hash !== hashInputs(stored.input)
    )
      throw new Error("Invalid preparation snapshot");
    const input = await loadInput(path.join(dataDir, "jobs", id), job.options.lang);
    if (hashInputs(input) !== stored.hash)
      throw new Error("Research changed since preparation; prepare again");
    const script = parseManualDraft(text, input);
    const dir = path.join(root, randomUUID());
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "script.json");
    const temporary = path.join(dir, "script.tmp");
    await writeFile(temporary, `${JSON.stringify(script, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
    return file;
  });
}
