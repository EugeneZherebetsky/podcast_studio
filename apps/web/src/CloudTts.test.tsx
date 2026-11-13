import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { CloudTts } from "./CloudTts.tsx";

test("cloud TTS exposes provider, model, voice and limit with billing disclosure", () => {
  const html = renderToString(<CloudTts status={{ elevenlabsConfigured: true, fishConfigured: false }} value={{ provider: "fish", model: "s2.1-pro-free", voice: "voice-id", inputLimit: 5000 }} onChange={() => {}} />);
  expect(html).toContain("ElevenLabs");
  expect(html).toContain("Fish Audio");
  expect(html).toContain("voice-id");
  expect(html).toContain("5000");
  expect(html).toContain("separately billed");
  expect(html).toContain("sent to the provider");

  expect(html).toContain("Piper");
});
