import { afterEach, expect, test } from "vitest";
import { TopicSchema } from "shared";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

const db = openDatabase(":memory:");
const app = buildApp({ db });
afterEach(async () => {
  await app.close();
  db.$client.close();
});

test("topic CRUD validates input and persists changes", async () => {
  const invalid = await app.inject({ method: "POST", url: "/api/topics", payload: { title: "" } });
  expect(invalid.statusCode).toBe(400);
  const created = await app.inject({
    method: "POST",
    url: "/api/topics",
    payload: { title: " News ", mode: "standard", lang: "en", minutes: 8 },
  });
  expect(created.statusCode).toBe(201);
  const topic = TopicSchema.parse(created.json());
  expect(topic.title).toBe("News");
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/topics/${topic.id}`,
    payload: { enabled: false },
  });
  expect(updated.json().enabled).toBe(false);
  const list = await app.inject({ url: "/api/topics" });
  expect(list.json().topics).toHaveLength(1);
  expect((await app.inject({ method: "DELETE", url: `/api/topics/${topic.id}` })).json()).toEqual({
    ok: true,
  });
  expect((await app.inject({ method: "DELETE", url: `/api/topics/${topic.id}` })).statusCode).toBe(
    404,
  );
});
