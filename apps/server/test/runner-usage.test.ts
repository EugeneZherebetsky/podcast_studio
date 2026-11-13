import { expect, test } from "vitest";
import { usage } from "../src/db/schema.ts";
import { createJob, generateJob, meterLlm } from "../src/pipeline/runner.ts";
import { LlmOutputError } from "../src/providers/llm/ai-sdk.ts";
import type { LlmProvider, Usage } from "../src/providers/llm/interface.ts";
import { monthTotalCostUsd } from "../src/usage.ts";
import { fakeGeneration, GENERATION_TIMEOUT_MS } from "./generation-fakes.ts";

const billed: Usage = {
  provider: "fake",
  model: "fake-main",
  inputTokens: 30,
  outputTokens: 12,
  costUsd: 0.5,
};

test("the meter reports answered calls and failed calls that were still billed", async () => {
  const seen: Usage[] = [];
  const outcomes: Array<() => Promise<unknown>> = [
    async () => ({ object: 1, usage: billed }),
    async () => {
      throw new LlmOutputError("no valid object", { ...billed, costUsd: 0.25 });
    },
    async () => {
      throw new Error("connection refused");
    },
  ];
  const inner = {
    localCacheIdentity: "ollama:model",
    generateObject: () => outcomes.shift()!(),
  } as unknown as LlmProvider;
  const llm = meterLlm(inner, (item) => seen.push(item));
  const request = { slot: "main" as const, system: "", prompt: "", schema: undefined as never };

  expect(llm.localCacheIdentity).toBe("ollama:model");
  await expect(llm.generateObject(request)).resolves.toMatchObject({ object: 1 });
  await expect(llm.generateObject(request)).rejects.toThrow("no valid object");
  await expect(llm.generateObject(request)).rejects.toThrow("connection refused");
  expect(seen.map((item) => item.costUsd)).toEqual([0.5, 0.25]);
});

test(
  "calls made before a stage fails are recorded and count towards the budget",
  async () => {
    const run = fakeGeneration();
    try {
      run.llm.costUsd = 0.5;
      // `notes` asks once per source and then once more to merge; let the merge call fail.
      const original = run.deps.providers.llm;
      const failMerge = true;
      run.deps.providers.llm = {
        generateObject(request) {
          if (failMerge && request.prompt.includes("<facts>"))
            throw new LlmOutputError("merge answer was not valid", { ...billed, costUsd: 0.25 });
          return original.generateObject(request);
        },
      };
      await expect(generateJob(run.deps, run.jobId)).rejects.toThrow("merge answer was not valid");
      expect(run.job().status).toBe("failed");
      expect(run.stageStatus("notes")).toBe("failed");

      const answered = run.llm.stages.length;
      const mapCalls = run.llm.stages.filter((stage) => stage === "notes").length;
      expect(mapCalls).toBeGreaterThanOrEqual(3);
      const rows = run.db.select().from(usage).all();
      // plan + every answered map call + the billed, failed merge call
      expect(rows).toHaveLength(answered + 1);
      expect(rows.every((row) => row.jobId === run.jobId && row.kind === "llm")).toBe(true);
      const spent = answered * 0.5 + 0.25;
      expect(monthTotalCostUsd(run.db)).toBeCloseTo(spent, 10);
      expect(() => createJob(run.db, run.job().options, spent - 0.1)).toThrow(/budget/i);

      await expect(generateJob(run.deps, run.jobId)).rejects.toThrow(/recovery is disabled/i);
      expect(run.db.select().from(usage).all()).toHaveLength(answered + 1);
    } finally {
      run.close();
    }
  },
  GENERATION_TIMEOUT_MS,
);
