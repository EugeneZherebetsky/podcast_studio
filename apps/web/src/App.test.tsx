import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App.tsx";

test("App renders the app name", () => {
  expect(renderToString(<App />)).toContain("Podcast Studio");
});
