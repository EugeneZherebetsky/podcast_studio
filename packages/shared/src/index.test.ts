import { expect, test } from "vitest";
import * as shared from "./index.ts";

test("shared package exports the app name", () => {
  expect(shared.APP_NAME).toBe("Podcast Studio");
});

test("every exported schema has a parser", () => {
  const schemas = Object.entries(shared).filter(([name]) => name.endsWith("Schema"));
  expect(schemas.length).toBeGreaterThan(30);
  for (const [name, schema] of schemas) {
    expect(typeof (schema as { safeParse?: unknown }).safeParse, name).toBe("function");
  }
});
