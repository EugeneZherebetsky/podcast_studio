import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { Settings } from "./Settings.tsx";

test("Gemini settings accurately describe the separate service and isolated draft", () => {
  const html = renderToString(<Settings />);
  expect(html).toContain("Gemini consumer account sign-in is not connected to this app");
  expect(html).toContain('href="https://gemini.google.com/"');
  expect(html).toContain("not connected to review, audio, or publication");
});
