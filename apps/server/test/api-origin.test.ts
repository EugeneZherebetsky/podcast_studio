import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("rejects rebinding hosts and cross-origin browser requests", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    for (const headers of [
      { host: "attacker.example:4747" },
      { host: "localhost:4747", origin: "https://attacker.example" },
      { host: "localhost:4747", origin: "http://localhost:9999" },
      { host: "localhost:4747", origin: "null" },
    ]) {
      expect((await app.inject({ method: "POST", url: "/api/topics", headers, payload: { name: "blocked" } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: "/api/topics", headers: { host: "localhost:4747", origin: "http://localhost:4747" } })).statusCode).toBe(200);
  } finally {
    await app.close();
    db.$client.close();
  }
});
