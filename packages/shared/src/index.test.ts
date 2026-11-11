import { expect, test } from "vitest";
import { APP_NAME } from "./index.ts";

test("shared package exports the app name", () => {
  expect(APP_NAME).toBe("Podcast Studio");
});
