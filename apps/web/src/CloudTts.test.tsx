import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { CloudTts } from "./CloudTts.tsx";

test("cloud TTS clearly shows inactive options, credential presence and costs", () => {
  const html = renderToString(<CloudTts status={{ openaiConfigured: true, azureConfigured: false }} />);
  expect(html).toContain("not active");
  expect(html).toContain("separately billed");
  expect(html).toContain("sent to the provider");
  expect(html).toContain("OpenAI: key present");
  expect(html).toContain("Azure: key not present");
  expect(html).toContain("disabled");
  expect(html).toContain("Piper");
});
