import { inspect } from "node:util";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { jobStages, usage } from "../src/db/schema.ts";
import { generateJob } from "../src/pipeline/runner.ts";
import { ChatGptCancelledError, ChatGptTimeoutError } from "../src/providers/llm/chatgpt-inference.ts";
import { CloudTtsBillingUncertain } from "../src/safe-generation-error.ts";
import { fakeGeneration } from "./generation-fakes.ts";

const secret = "synthetic-provider-credential-do-not-disclose";
const recovery = "external work may still be running; stop the server and follow manual recovery in SETUP.md";

test.each([
  [() => new DOMException(secret, "AbortError"), "Generation cancelled"],
  [() => new DOMException(secret, "TimeoutError"), "Generation timed out"],
  [() => new ChatGptTimeoutError(), "ChatGPT request timed out; remote work may still be running"],
  [() => new ChatGptCancelledError(), "ChatGPT request cancelled; remote work may still be running"],
  [() => new CloudTtsBillingUncertain(), "Cloud TTS failed; the provider may have billed this request"],
])("persists and publishes classified uncertain provider failures safely", async (makeError, classification) => {
  const f = fakeGeneration();
  const events: unknown[] = [];
  const app = buildApp({ db: f.db });
  const original = Object.assign(makeError(), { cause: new Error(secret), usage: { provider: "fake", model: "fake-fast", inputTokens: 1, outputTokens: 2, costUsd: 0, extra: secret } });
  f.deps.providers.llm = { async generateObject() { throw original; } };
  f.deps.onEvent = (event) => events.push(event);
  const expected = `${classification}; ${recovery}`;
  try {
    const error = await generateJob(f.deps, f.jobId).catch((error: unknown) => error);
    const stage = f.db.select().from(jobStages).where(eq(jobStages.jobId, f.jobId)).all().find((row) => row.stage === "plan")!;
    expect(f.job()).toMatchObject({ status: "failed", error: expected });
    expect(stage).toMatchObject({ status: "failed", error: expected });
    expect(events).toContainEqual(expect.objectContaining({ type: "job-stage", status: "failed", error: expected }));
    expect(f.db.select().from(usage).all()).toHaveLength(1);
    const response = await app.inject({ url: `/api/jobs/${f.jobId}` });
    expect(response.json()).toMatchObject({ status: "failed", error: expected, stages: expect.arrayContaining([expect.objectContaining({ stage: "plan", error: expected })]) });
    for (const text of [inspect(error, { depth: 10, showHidden: true }), JSON.stringify(error, Object.getOwnPropertyNames(error)), JSON.stringify(events), JSON.stringify(f.job()), JSON.stringify(stage), response.body]) expect(text).not.toContain(secret);
  } finally { await app.close(); f.close(); }
});
