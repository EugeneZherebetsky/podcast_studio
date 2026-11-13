// A whole fake generation for runner tests: scripted LLM answers for every stage, a temp
// data directory and an in-memory database. Nothing here touches the network or ./data.
import path from "node:path";
import { eq } from "drizzle-orm";
import type { JobOptions, StageName } from "shared";
import { openDatabase, type Db } from "../src/db/index.ts";
import { jobs, jobStages } from "../src/db/schema.ts";
import { createJob, type GenerateDeps } from "../src/pipeline/runner.ts";
import { createFakeProviders, type FakeProviders } from "../src/providers/index.ts";
import type { FakeLlmCall } from "../src/providers/llm/fake.ts";
import type {
  GenerateObjectRequest,
  GenerateObjectResult,
  LlmProvider,
} from "../src/providers/llm/interface.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

/** Generous: the assemble stage runs ffmpeg, which is slow when the machine is busy. */
export const GENERATION_TIMEOUT_MS = 120_000;

/** A valid answer for whichever stage is asking. */
export function respond(call: FakeLlmCall): unknown {
  const id = /<source id="(s\d+)">/.exec(call.prompt)?.[1];
  if (id) return { facts: [`Fact from ${id}`] };
  if (call.prompt.includes("<facts>"))
    return { outline: [{ heading: "Facts", facts: [{ text: "A fact", sourceIds: ["s1"] }] }] };
  if (call.slot === "fast")
    return { queries: ["one", "two", "three", "four", "five"], angle: "Bees" };
  const kinds = ["intro", "content", "content", "content", "recap", "outro"];
  return {
    // Script and review answers in one object: each schema drops the keys it does not know.
    title: "Bees",
    summary: "About bees",
    chapters: [1, 2, 3].map((segmentIndex) => ({ title: `Chapter ${segmentIndex}`, segmentIndex })),
    segments: kinds.map((kind) => ({
      kind,
      speaker: "host",
      lang: "en",
      text: Array(23).fill("bees").join(" "),
      ...(kind === "content" ? { sourceIds: ["s1"] } : {}),
    })),
    findings: [],
  };
}

export interface LlmControl {
  /** The job stage each call that reached the fake LLM was made in, in call order. */
  readonly stages: StageName[];
  /** A call made in this stage never returns, as if the process had died there. */
  hangIn?: StageName;
  /** Resolves when a call has hung. */
  readonly hung: Promise<void>;
  /** A call made in this stage fails. */
  failIn?: StageName;
  /** Cost reported for every answered call. */
  costUsd: number;
}

export interface FakeGeneration {
  dir: string;
  db: Db;
  providers: FakeProviders;
  deps: GenerateDeps;
  jobId: string;
  workDir: string;
  llm: LlmControl;
  job(): typeof jobs.$inferSelect;
  stageStatus(stage: StageName): string;
  close(): void;
}

export function fakeGeneration(options: Partial<JobOptions> = {}): FakeGeneration {
  const dir = makeTempDir();
  const db = openDatabase(":memory:");
  const providers = createFakeProviders({ wavDir: path.join(dir, "wav") });
  providers.llm.enqueue(...Array.from({ length: 200 }, () => respond));
  const job = createJob(
    db,
    {
      title: "Bees",
      brief: "",
      mode: "standard",
      lang: "en",
      minutes: 1,
      review: false,
      ...options,
    },
    20,
  );
  const getJob = () => db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
  let reportHung!: () => void;
  const llm: LlmControl = {
    stages: [],
    costUsd: 0,
    hung: new Promise<void>((resolve) => {
      reportHung = resolve;
    }),
  };
  const controlled: LlmProvider = {
    diagnostic: providers.llm.diagnostic,
    async generateObject<T>(request: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      const stage = getJob().currentStage!;
      if (stage === llm.hangIn) {
        reportHung();
        return new Promise<never>(() => {});
      }
      if (stage === llm.failIn) throw new Error(`model offline during ${stage}`);
      llm.stages.push(stage);
      const result = await providers.llm.generateObject(request);
      return { ...result, ...(result.usage ? { usage: { ...result.usage, costUsd: llm.costUsd } } : {}) };
    },
  };
  return {
    dir,
    db,
    providers,
    jobId: job.id,
    workDir: path.join(dir, "jobs", job.id),
    llm,
    deps: {
      db,
      providers: { ...providers, llm: controlled },
      dataDir: dir,
      budgetUsd: 20,
      voice: "fake",
      profile: "local",
      llmName: "fake",
      ttsName: "fake",
      nativeLang: "en",
    },
    job: getJob,
    stageStatus: (stage) =>
      db
        .select()
        .from(jobStages)
        .all()
        .find((row) => row.jobId === job.id && row.stage === stage)!.status,
    close() {
      db.$client.close();
      removeTempDir(dir);
    },
  };
}
