import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

test("non-loopback requests are refused even with forwarded headers or bearer tokens", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp({ db });
  try {
    const response = await app.inject({
      url: "/api/topics",
      remoteAddress: "192.0.2.1",
      headers: { authorization: "Bearer example", "x-forwarded-for": "127.0.0.1" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Remote access is not available" });
  } finally {
    await app.close();
    db.$client.close();
  }
});
