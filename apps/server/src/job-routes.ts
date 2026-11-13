import { eq } from "drizzle-orm";
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
import { jobs, jobStages, settings, topics } from "./db/schema.ts";
import { publicJobError } from "./job-log.ts";

// T12 owns job execution and its state transitions; HTTP must not simulate them.
export interface JobRunner {
  create(request: CreateJobRequest): Promise<Job>;
  retry(id: string, request: RetryJobRequest): Promise<Job>;
  cancel(id: string): Promise<Job>;
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
