import { expect, test } from "vitest";
import { z } from "zod";
import { formatZodError } from "./index.ts";

function errorOf(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected a failure");
  return result.error;
}

test("formats one line per issue with a dotted, indexed path", () => {
  const schema = z.object({ a: z.string(), list: z.array(z.object({ n: z.number() })) });
  const message = formatZodError(errorOf(schema, { a: 1, list: [{ n: 1 }, { n: "x" }] }));
  const lines = message.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^a: .*string/);
  expect(lines[1]).toMatch(/^list\[1\]\.n: .*number/);
});

test("root-level issues have no path prefix", () => {
  expect(formatZodError(errorOf(z.string(), 5))).toMatch(/^Invalid input: expected string/);
});

test("union failures explain every alternative instead of a bare 'Invalid input'", () => {
  const schema = z.object({
    body: z.union([z.object({ topicId: z.string() }), z.object({ minutes: z.number() })]),
  });
  const message = formatZodError(errorOf(schema, { body: { minutes: "8" } }));
  expect(message).toMatch(/^body: Invalid input: none of the 2 allowed shapes matched/);
  expect(message).toMatch(/option 1: topicId: .*string/);
  expect(message).toMatch(/option 2: minutes: .*number/);
});
