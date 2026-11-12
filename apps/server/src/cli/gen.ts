import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { JobOptionsSchema } from "shared";
import { loadConfig } from "../config.ts";
import { ensureDataDirs } from "../data-dir.ts";
import { openDatabase } from "../db/index.ts";
import { jobs } from "../db/schema.ts";
import { createJob, generateJob } from "../pipeline/runner.ts";
import { createProviders } from "../providers/index.ts";

async function main(): Promise<void> {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      minutes: { type: "string", default: "8" },
      lang: { type: "string", default: "en" },
      mode: { type: "string", default: "standard" },
      brief: { type: "string", default: "" },
      voice: { type: "string" },
      resume: { type: "string" },
      "no-review": { type: "boolean" },
    },
  });
  const config = loadConfig();
  if (
    config.PROFILE !== "local" ||
    config.SEARCH_PROVIDER !== "searxng" ||
    config.TTS_PROVIDER !== "piper"
  )
    throw new Error(
      "Generation requires local Ollama, SearXNG and Piper; paid providers are disabled until their costs can be accounted safely",
    );
  if (!args.values.resume && args.positionals.length !== 1)
    throw new Error(
      'Usage: pnpm gen "topic" [--minutes 8] [--lang en] [--mode standard] [--voice ID] [--no-review], or --resume JOB_ID',
    );
  const dirs = ensureDataDirs(config.DATA_DIR);
  const db = openDatabase(dirs.dbFile);
  try {
    const providers = createProviders(config);
    const input = args.values.resume
      ? undefined
      : JobOptionsSchema.parse({
          title: args.positionals[0],
          brief: args.values.brief,
          mode: args.values.mode,
          lang: args.values.lang,
          minutes: Number(args.values.minutes),
          review: !args.values["no-review"],
        });
    if (input && input.mode !== "standard") throw new Error("Only standard mode is supported");
    const id = args.values.resume ?? createJob(db, input!, config.MONTHLY_BUDGET_USD).id;
    console.log(`Job ${id}`);
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new Error("Job not found");
    const voice =
      args.values.voice ??
      (job.options.lang.toLowerCase().startsWith("hu")
        ? config.TTS_VOICE_HU_HOST
        : config.TTS_VOICE_NATIVE_HOST);
    if (!voice) throw new Error("Set TTS_VOICE_NATIVE_HOST in .env or pass --voice");
    await generateJob(
      {
        db,
        providers,
        dataDir: dirs.root,
        budgetUsd: config.MONTHLY_BUDGET_USD,
        voice,
        profile: config.PROFILE,
        llmName: config.OLLAMA_MODEL_MAIN,
        ttsName: config.TTS_PROVIDER,
        nativeLang: config.NATIVE_LANG,
      },
      id,
    );
    console.log(`Published ${dirs.episodes}/${id}/audio.m4a`);
  } finally {
    db.$client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
