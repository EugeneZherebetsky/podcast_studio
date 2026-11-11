import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";

test("the bare app answers unknown routes with 404", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/nope" });
  expect(res.statusCode).toBe(404);
  await app.close();
});
