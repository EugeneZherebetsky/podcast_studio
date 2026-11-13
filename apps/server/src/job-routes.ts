import { and, eq } from "drizzle-orm";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  CreateJobRequestSchema,
  RetryJobRequestSchema,
  type CreateJobRequest,
  type Job,
  type RetryJobRequest,
  type AppConfig,
  SettingsSchema,
} from "shared";
import type { Db } from "./db/index.ts";
import { jobs, jobStages, settings, topics, usage } from "./db/schema.ts";
import { createJobLog, publicJobError, safeModel } from "./job-log.ts";
import { ScriptSchema } from "./pipeline/script.ts";

// T12 owns job execution and its state transitions; HTTP must not simulate them.
export interface JobRunner {
  create(request: CreateJobRequest): Promise<Job>;
  retry(id: string, request: RetryJobRequest): Promise<Job>;
  cancel(id: string): Promise<Job>;
  isBusy?(id: string): boolean;
}

export function registerJobRoutes(
  app: FastifyInstance,
  db: Db,
  runner?: JobRunner,
  config?: AppConfig,
): void {
  function learningBlocked(mode: string): boolean {
    if (!config || config.ALLOW_LOCAL_LEARNING || mode === "standard") return false;
    const row = db.select().from(settings).where(eq(settings.key, "api-settings")).get();
    const saved = row ? SettingsSchema.parse(row.value) : undefined;
    // The runner's profile is not yet connected to saved settings; guard either profile.
    return config.PROFILE === "local" || saved?.profile === "local";
  }
  const publicJob = ({ ownerToken, ...job }: typeof jobs.$inferSelect) => {
    void ownerToken;
    return { ...job, error: publicJobError(job.error) };
  };
  app.get("/api/jobs", async () => ({ jobs: db.select().from(jobs).all().map(publicJob) }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/details", async (request, reply) => {
    const job = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const stage = db.select().from(jobStages).where(and(eq(jobStages.jobId, job.id), eq(jobStages.stage, "script"))).get();
    let script: string | null = null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (config && uuid.test(job.id) && job.ownerToken && uuid.test(job.ownerToken) && stage?.inputHash && (stage.status === "done" || stage.status === "skipped")) {
      try {
        const dirs = [config.DATA_DIR, path.join(config.DATA_DIR, "jobs"), path.join(config.DATA_DIR, "jobs", job.id), path.join(config.DATA_DIR, "jobs", job.id, "runs"), path.join(config.DATA_DIR, "jobs", job.id, "runs", job.ownerToken)];
        const file = path.join(dirs[4]!, "script.json");
        const hash = path.join(dirs[4]!, "script.inputs.sha256");
        for (const item of [...dirs, file, hash]) if (lstatSync(item).isSymbolicLink()) throw new Error("Link rejected");
        if (lstatSync(file).size > 2_000_000 || lstatSync(hash).size > 256 || readFileSync(hash, "utf8").trim() !== stage.inputHash) throw new Error("Invalid artifact");
        const parsed = ScriptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        script = parsed.segments.map((segment) => segment.text).join("\n\n");
      } catch { /* Missing, unsafe or invalid artifacts are not displayed. */ }
    }
    const known = new Set(["ollama", "openai", "anthropic", "gemini", "chatgpt", "fake"]);
    const recorded = config ? (() => { try { return createJobLog(config.DATA_DIR).read(job.id).entries.flatMap((entry) => entry.request ? [entry.request] : entry.selection ? [entry.selection] : []); } catch { return []; } })() : [];
    const providers = [...new Set([...db.select({ provider: usage.provider }).from(usage).where(eq(usage.jobId, job.id)).all().map((row) => row.provider), ...recorded.map((entry) => entry.provider)].filter((provider) => known.has(provider)))];
    const models = [...new Set(recorded.map((entry) => safeModel(entry.model)).filter((model): model is string => model !== null))];
    return reply.header("cache-control", "no-store").send({ script, providers, model: models.length ? models.join(", ") : null });
  });
  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const id = request.params.id;
    const result = db.transaction((tx) => {
      const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!job) return 404;
      if (!['succeeded', 'failed', 'cancelled'].includes(job.status) || runner?.isBusy?.(id) ||
          tx.select().from(jobStages).where(and(eq(jobStages.jobId, id), eq(jobStages.status, 'running'))).get()) return 409;
      tx.delete(jobs).where(eq(jobs.id, id)).run();
      return 200;
    });
    if (result === 404) return reply.code(404).send({ error: "Job not found" });
    if (result === 409) return reply.code(409).send({ error: "Job is still active" });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return {
      ...publicJob(job),
      stages: db.select().from(jobStages).where(eq(jobStages.jobId, job.id)).all().map((stage) => ({ ...stage, error: publicJobError(stage.error) })),
    };
  });
  app.post("/api/jobs", async (request, reply) => {
    const body = CreateJobRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const mode =
      "topicId" in body.data
        ? db.select().from(topics).where(eq(topics.id, body.data.topicId)).get()?.mode
        : body.data.mode;
    if (!mode) return reply.code(404).send({ error: "Topic not found" });
    if (learningBlocked(mode))
      return reply.code(400).send({ error: "Local learning modes require ALLOW_LOCAL_LEARNING=1" });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    try {
      return reply.code(201).send(await runner.create(body.data));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const body = RetryJobRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const job = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return reply.code(409).send({ error: "Retry is disabled until job recovery is safe" });
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry-as-new", async (request, reply) => {
    if (request.body !== undefined && (request.body === null || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length))
      return reply.code(400).send({ error: "Expected an empty request body" });
    const job = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.status !== "failed") return reply.code(409).send({ error: "Only failed jobs can be retried as new" });
    if (learningBlocked(job.options.mode)) return reply.code(400).send({ error: "Local learning modes require ALLOW_LOCAL_LEARNING=1" });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    try {
      return reply.code(201).send(await runner.create(job.options));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    if (!db.select().from(jobs).where(eq(jobs.id, request.params.id)).get())
      return reply.code(404).send({ error: "Job not found" });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    try {
      return await runner.cancel(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
