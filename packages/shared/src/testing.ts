// Test helpers. Not exported from the package.
import { expect } from "vitest";
import type { ZodType } from "zod";
import { formatZodError } from "./errors.ts";

export function expectValid(schema: ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a valid value, got: ${formatZodError(result.error)}`);
  }
}

/** Asserts rejection and that the readable message matches every given pattern. */
export function expectInvalid(schema: ZodType, value: unknown, ...patterns: RegExp[]): string {
  const result = schema.safeParse(value);
  expect(result.success, "expected the value to be rejected").toBe(false);
  if (result.success) return "";
  const message = formatZodError(result.error);
  expect(message.length).toBeGreaterThan(0);
  for (const pattern of patterns) expect(message).toMatch(pattern);
  return message;
}
