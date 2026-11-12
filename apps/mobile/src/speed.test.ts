import { expect, it } from "vitest";
import { readSpeed, stepSpeed } from "./speed";

it("uses bounded five-percent steps and validates stored speeds", () => {
  expect(stepSpeed(1, 1)).toBe(1.05);
  expect(stepSpeed(0.5, -1)).toBe(0.5);
  expect(stepSpeed(1.5, 1)).toBe(1.5);
  expect(readSpeed("1.15")).toBe(1.15);
  expect(readSpeed("1.03")).toBe(1);
  expect(readSpeed(null)).toBe(1);
});
