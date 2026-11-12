import { expect, test, vi } from "vitest";
import { parseConfig } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { topics } from "../src/db/schema.ts";

test("saved local preference blocks learning topic jobs even with a cloud startup profile", async () => {
  const db = openDatabase(":memory:");
  db.insert(topics).values({ id: "topic", title: "News", mode: "bilingual", lang: "en", minutes: 8 }).run();
  const runner = { create: vi.fn(), retry: vi.fn(), cancel: vi.fn() };
  const app = buildApp({ db, runner, config: parseConfig({ PROFILE: "cloud" }) });
  try {
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: { profile: "local" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/settings" })).json().profile).toBe("local");
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: { topicId: "topic" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("ALLOW_LOCAL_LEARNING=1");
    expect(runner.create).not.toHaveBeenCalled();
    db.update(topics).set({ mode: "standard" }).run();
    runner.create.mockResolvedValue({});
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload: { topicId: "topic" } })).statusCode).toBe(201);
  } finally {
    await app.close();
    db.$client.close();
  }
});
