import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  CreateJobRequestSchema,
  RetryJobRequestSchema,
  type CreateJobRequest,
  type Job,
  type RetryJobRequest,
} from "shared";
import type { Db } from "./db/index.ts";
import { jobs, jobStages } from "./db/schema.ts";

// T12 owns job execution and its state transitions; HTTP must not simulate them.
export interface JobRunner {
  create(request: CreateJobRequest): Promise<Job>;
  retry(id: string, request: RetryJobRequest): Promise<Job>;
  cancel(id: string): Promise<Job>;
}

export function registerJobRoutes(app: FastifyInstance, db: Db, runner?: JobRunner): void {
  app.get("/api/jobs", async () => ({ jobs: db.select().from(jobs).all() }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return { ...job, stages: db.select().from(jobStages).where(eq(jobStages.jobId, job.id)).all() };
  });
  app.post("/api/jobs", async (request, reply) => {
    const body = CreateJobRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    return reply.code(201).send(await runner.create(body.data));
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const body = RetryJobRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    if (!db.select().from(jobs).where(eq(jobs.id, request.params.id)).get())
      return reply.code(404).send({ error: "Job not found" });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    return runner.retry(request.params.id, body.data);
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    if (!db.select().from(jobs).where(eq(jobs.id, request.params.id)).get())
      return reply.code(404).send({ error: "Job not found" });
    if (!runner) return reply.code(503).send({ error: "Job runner unavailable" });
    return runner.cancel(request.params.id);
  });
}
