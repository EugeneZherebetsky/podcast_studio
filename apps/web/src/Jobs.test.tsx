import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ values: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: () => [state.values.shift(), vi.fn()], useEffect: () => {}, useCallback: (fn: unknown) => fn, useRef: (value: unknown) => ({ current: value }) };
});
import { Jobs } from "./Jobs.tsx";

test("renders job details and progress log", () => {
  state.values = [
    [{ id: "one", options: { title: "A topic", brief: "A brief", lang: "en", minutes: 5, mode: "brief" }, createdAt: "2026-01-01T00:00:00Z", status: "failed", stages: [] }],
    "", true, "one", "one", { providers: ["chatgpt"], model: "gpt-4o", script: "Saved script" }, "", false,
    { available: true, partial: true, entries: [{ timestamp: "2026-01-01T00:00:00Z", message: "ChatGPT script: 3 events, 20 bytes received" }] },
    "", 0, false, "",
  ];
  const html = renderToStaticMarkup(<Jobs />);
  expect(html).toContain("A topic");
  expect(html).toContain("A brief");
  expect(html).toContain("gpt-4o");
  expect(html).toContain("Saved script");
  expect(html).toContain("ChatGPT script: 3 events, 20 bytes received");
  expect(html).toContain("incomplete or truncated");
  expect(html).toContain("Delete job");
});
