import { EventEmitter } from "node:events";
import { and, eq, inArray } from "drizzle-orm";
import {
  JobOptionsSchema,
  SettingsSchema,
  type AppConfig,
  type CreateJobRequest,
  type Job,
} from "shared";
import { jobs, topics, settings } from "./db/schema.ts";
import type { JobRunner } from "./job-routes.ts";
import { cancelJob, ExternalWorkUncertain, createJob, generateJob, type GenerateDeps } from "./pipeline/runner.ts";
import { openDesktopGuard } from "./desktop-guard.ts";
import type { createScriptSelection } from "./chatgpt-selection.ts";

/** Owns only jobs created in this process; never scans persisted jobs for work. */
export function createDesktopRunner(
  deps: GenerateDeps,
  events: EventEmitter,
  config?: AppConfig,
  selection?: ReturnType<typeof createScriptSelection>,
): JobRunner & { close(): Promise<boolean> } {
  const guard = openDesktopGuard(deps.dataDir);
  const queue: { id: string; deps: GenerateDeps }[] = [];
  let active: Promise<void> | undefined;
  let activeId: string | undefined;
  let abort: AbortController | undefined;
  let closing = false;
  let uncertain = false;
  const get = (id: string): Job => {
    const row = deps.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new Error("Job not found");
    const { ownerToken, ...job } = row;
    void ownerToken;
    return job;
  };
  function pump(): void {
    if (closing || active || uncertain) return;
    const item = queue.shift();
    if (!item) return;
    const { id } = item;
    if (get(id).status !== "queued") return pump();
    activeId = id;
    abort = new AbortController();
    events.emit("job-progress", id, { kind: "job", status: "started" });
    active = generateJob({ ...item.deps, signal: abort.signal, onEvent: (event) => events.emit("event", event), onProgress: (progress) => events.emit("job-progress", id, progress) }, id)
      .then(() => { events.emit("job-progress", id, { kind: "job", status: "completed" }); })
      .catch((error: unknown) => {
        // A failed request may still be running in an external service.
        if (error instanceof ExternalWorkUncertain) {
          uncertain = true;
          const blocked = "External work may still be running; stop the server and follow manual recovery in SETUP.md";
          for (const queued of queue.splice(0)) {
            const result = deps.db.update(jobs)
              .set({ status: "failed", error: blocked, updatedAt: new Date().toISOString() })
              .where(and(eq(jobs.id, queued.id), eq(jobs.status, "queued"))).run();
            if (result.changes) {
              events.emit("event", { type: "job-stage", jobId: queued.id, stage: "plan", status: "failed", error: blocked });
              events.emit("job-progress", queued.id, { kind: "job", status: "failed" });
            }
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        deps.db
          .update(jobs)
          .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
          .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "running"])))
          .run();
        events.emit("job-progress", id, { kind: "job", status: get(id).status === "cancelled" ? "cancelled" : "failed" });
      })
      .finally(() => {
        active = undefined;
        activeId = undefined;
        abort = undefined;
        pump();
      });
  }
  return {
    async create(request: CreateJobRequest) {
      if (closing) throw new Error("Runner is shutting down");
      if (uncertain) throw new Error("External work may still be running; stop the server and follow manual recovery in SETUP.md");
      const topic =
        "topicId" in request
          ? deps.db.select().from(topics).where(eq(topics.id, request.topicId)).get()
          : undefined;
      if ("topicId" in request && !topic) throw new Error("Topic not found");
      const options = JobOptionsSchema.parse(
        topic ? { ...topic, level: topic.level ?? undefined } : request,
      );
      if (options.mode !== "standard") throw new Error("Only standard mode is supported");
      const savedRow = deps.db
        .select()
        .from(settings)
        .where(eq(settings.key, "api-settings"))
        .get();
      const saved = savedRow ? SettingsSchema.parse(savedRow.value) : undefined;
      if (
        config &&
        (config.PROFILE !== "local" ||
          config.SEARCH_PROVIDER !== "searxng" ||
          config.TTS_PROVIDER !== "piper" ||
          (saved && saved.profile !== "local"))
      )
        throw new Error("Generation requires local Ollama, SearXNG and Piper");
      const voice = config
        ? options.lang.toLowerCase().startsWith("hu")
          ? (saved?.voices.huHost ?? config.TTS_VOICE_HU_HOST)
          : (saved?.voices.nativeHost ?? config.TTS_VOICE_NATIVE_HOST)
        : deps.voice;
      if (!voice) throw new Error("Configure a local Piper voice before generating");
      const jobDeps = {
        ...deps,
        ...(selection ? selection.capture() : {}),
        voice,
        budgetUsd: saved?.monthlyBudgetUsd ?? deps.budgetUsd,
        nativeLang: saved?.nativeLang ?? deps.nativeLang,
      };
      guard.begin();
      const job = createJob(deps.db, options, jobDeps.budgetUsd);
      if (topic) {
        deps.db.update(jobs).set({ topicId: topic.id }).where(eq(jobs.id, job.id)).run();
      }
      queue.push({ id: job.id, deps: jobDeps });
      events.emit("job-progress", job.id, { kind: "job", status: "queued" });
      setImmediate(pump);
      return { ...job, topicId: topic?.id ?? null };
    },
    async retry() {
      throw new Error("Retry is disabled");
    },
    async cancel(id) {
      if (id !== activeId && !queue.some((item) => item.id === id))
        throw new Error("Job is not owned by this runner");
      cancelJob(deps.db, id);
      if (id !== activeId) events.emit("job-progress", id, { kind: "job", status: "cancelled" });
      if (id === activeId) abort?.abort();
      return get(id);
    },
    async close() {
      closing = true;
      for (const { id } of queue.splice(0)) {
        cancelJob(deps.db, id);
        events.emit("job-progress", id, { kind: "job", status: "cancelled" });
      }
      if (activeId && get(activeId).currentStage !== "publish") {
        cancelJob(deps.db, activeId);
        abort?.abort();
      }
      if (!active) {
        guard.close(!uncertain);
        return true;
      }
      const drained = await Promise.race([
        active.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (drained) guard.close(!uncertain);
      return drained;
    },
  };
}
