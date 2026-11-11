import { expect, test } from "vitest";
import { z } from "zod";
import { FakeLlmProvider } from "../src/providers/llm/fake.ts";

const PlanSchema = z.object({ angle: z.string(), queries: z.array(z.string()).min(1) });
const plan = { angle: "what changed this year", queries: ["a", "b"] };
const request = { slot: "fast", system: "You plan episodes.", prompt: "Topic: bees" } as const;

test("returns queued objects in order and records every call", async () => {
  const llm = new FakeLlmProvider({ responses: [plan] });
  llm.enqueue({ angle: "second", queries: ["c"] });

  const first = await llm.generateObject({ ...request, schema: PlanSchema });
  const second = await llm.generateObject({
    slot: "main",
    system: "s2",
    prompt: "p2",
    schema: PlanSchema,
  });

  expect(first.object).toEqual(plan);
  expect(second.object.angle).toBe("second");
  expect(llm.calls).toHaveLength(2);
  expect(llm.calls[0]).toMatchObject({
    slot: "fast",
    system: "You plan episodes.",
    prompt: "Topic: bees",
  });
  expect(llm.calls[0]?.schema).toBe(PlanSchema);
  expect(llm.calls[1]).toMatchObject({ slot: "main", system: "s2", prompt: "p2" });
  expect(llm.pending).toBe(0);
});

test("a queued function builds the response from the call", async () => {
  const llm = new FakeLlmProvider();
  llm.enqueue((call) => ({ angle: `${call.slot}:${call.prompt}`, queries: ["q"] }));
  const { object } = await llm.generateObject({ ...request, schema: PlanSchema });
  expect(object.angle).toBe("fast:Topic: bees");
});

test("returns the parsed value, so schema defaults and stripping apply", async () => {
  const schema = z.object({ title: z.string(), minutes: z.number().default(10) });
  const llm = new FakeLlmProvider({ responses: [{ title: "Bees", extra: true }] });
  const { object } = await llm.generateObject({ ...request, schema });
  expect(object).toEqual({ title: "Bees", minutes: 10 });
});

test("rejects an object that does not match the schema, naming the field", async () => {
  const llm = new FakeLlmProvider({ responses: [{ angle: "x", queries: "not-an-array" }] });
  await expect(llm.generateObject({ ...request, schema: PlanSchema })).rejects.toThrowError(
    /does not match the schema[\s\S]*queries/,
  );
  expect(llm.calls).toHaveLength(1); // the call is still recorded
});

test("fails readably when nothing is queued", async () => {
  const llm = new FakeLlmProvider();
  await expect(llm.generateObject({ ...request, schema: PlanSchema })).rejects.toThrowError(
    /FakeLlmProvider: no response queued for call #1 \(slot "fast"\)/,
  );
});

test("usage is deterministic and free", async () => {
  const run = async () => {
    const llm = new FakeLlmProvider({ responses: [plan] });
    return (await llm.generateObject({ ...request, schema: PlanSchema })).usage;
  };
  const usage = await run();
  expect(usage).toEqual(await run());
  expect(usage).toMatchObject({ provider: "fake", model: "fake-fast", costUsd: 0 });
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.outputTokens).toBeGreaterThan(0);
  expect(Number.isInteger(usage.inputTokens) && Number.isInteger(usage.outputTokens)).toBe(true);
});

test("reset clears the queue and the recorded calls", async () => {
  const llm = new FakeLlmProvider({ responses: [plan, plan] });
  await llm.generateObject({ ...request, schema: PlanSchema });
  llm.reset();
  expect(llm.calls).toHaveLength(0);
  expect(llm.pending).toBe(0);
});
