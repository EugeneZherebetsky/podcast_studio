// Stage artifacts (ARCHITECTURE §3): every stage writes one JSON file into the job's work
// directory and, next to it, the sha256 of its inputs. A stage whose artifact exists and
// whose input hash is unchanged is skipped. Because a stage's inputs include the artifact
// of the stage before it, a change upstream re-runs exactly the stages it reaches.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatZodError, type StageName } from "shared";
import type { ZodType } from "zod";
import type { Usage } from "../providers/llm/interface.ts";

/** Artifact file of each stage that has one so far; later stages add their own. */
export const ARTIFACT_FILES = {
  plan: "plan.json",
  search: "candidates.json",
  extract: "sources.json",
  notes: "notes.json",
} as const satisfies Partial<Record<StageName, string>>;

export type CachedStageName = keyof typeof ARTIFACT_FILES;

export interface ArtifactPaths {
  /** The stage's JSON artifact, e.g. `<workDir>/plan.json`. */
  artifact: string;
  /** Hex sha256 of the inputs that produced it, e.g. `<workDir>/plan.inputs.sha256`. */
  hash: string;
}

export function artifactPaths(workDir: string, stage: CachedStageName): ArtifactPaths {
  const file = ARTIFACT_FILES[stage];
  return {
    artifact: path.join(workDir, file),
    hash: path.join(workDir, `${path.basename(file, ".json")}.inputs.sha256`),
  };
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/**
 * Hex sha256 of any JSON-serialisable value. Key order and `undefined` properties do not
 * matter; array order does.
 */
export function hashInputs(inputs: unknown): string {
  return createHash("sha256")
    .update(stableStringify(inputs) ?? "undefined")
    .digest("hex");
}

export interface StageOutput<T> {
  artifact: T;
  /** One entry per LLM call the stage made, for the cost guard. */
  usage: Usage[];
}

export interface StageResult<T> extends StageOutput<T> {
  /** True when the stored artifact was returned and the stage did not run. */
  skipped: boolean;
  /** Hash of the inputs; the runner stores it in `job_stages.inputHash`. */
  inputHash: string;
}

export interface CachedStage<T> {
  /** The job's work directory (`data/jobs/<jobId>/`); created if missing. */
  workDir: string;
  stage: CachedStageName;
  /** Everything the output depends on. Must be JSON-serialisable. */
  inputs: unknown;
  /** Validates the artifact, both when it is produced and when it is read back. */
  schema: ZodType<T>;
  run: () => Promise<StageOutput<T>>;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function readStoredArtifact<T>(
  paths: ArtifactPaths,
  inputHash: string,
  schema: ZodType<T>,
): Promise<{ artifact: T } | undefined> {
  if ((await readText(paths.hash))?.trim() !== inputHash) return undefined;
  const text = await readText(paths.artifact);
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { artifact: parsed.data } : undefined;
  } catch {
    return undefined; // damaged file: produce it again
  }
}

/** Writes through a temporary file so a crash never leaves half a file behind. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

/**
 * Runs a stage unless its artifact is already there for the same inputs. A stage that
 * throws writes nothing: whatever was stored before stays valid for its own inputs.
 */
export async function runCachedStage<T>(options: CachedStage<T>): Promise<StageResult<T>> {
  const { workDir, stage, schema } = options;
  const paths = artifactPaths(workDir, stage);
  const inputHash = hashInputs(options.inputs);

  const stored = await readStoredArtifact(paths, inputHash, schema);
  if (stored) return { artifact: stored.artifact, usage: [], skipped: true, inputHash };

  const output = await options.run();
  const parsed = schema.safeParse(output.artifact);
  if (!parsed.success) {
    throw new Error(
      `Stage "${stage}" produced an invalid ${ARTIFACT_FILES[stage]}:\n` +
        formatZodError(parsed.error),
    );
  }

  await mkdir(workDir, { recursive: true });
  // The hash goes first and comes back last: if the process dies in between, no hash is
  // left to vouch for an artifact it does not belong to.
  await rm(paths.hash, { force: true });
  await writeFileAtomic(paths.artifact, `${JSON.stringify(parsed.data, null, 2)}\n`);
  await writeFileAtomic(paths.hash, `${inputHash}\n`);
  return { artifact: parsed.data, usage: output.usage, skipped: false, inputHash };
}
