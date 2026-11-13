import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { PairingStatus, UsageTotal, VoicePicker } from "./SettingsExtras.tsx";

test("pairing status explains why a phone QR is unavailable without exposing a code", () => {
  const html = renderToString(<PairingStatus />);
  expect(html).toContain("Phone pairing is not available yet");
  expect(html).toContain("Localhost refers to the phone itself");
  expect(html).toContain("Plain HTTP exposes pairing codes and device tokens");
  expect(html).toContain("reverse proxy is not supported");
  expect(html).not.toContain("podcast-studio://pair");
});

test("usage displays the recorded UTC month total without rounding small costs to zero", () => {
  expect(renderToString(<UsageTotal totalUsd={1} />)).toContain("Cloud TTS charges are excluded; recorded usage is not total cost.");
  expect(renderToString(<UsageTotal totalUsd={0.0012} />)).toContain("0.0012");
  expect(renderToString(<UsageTotal totalUsd={0.00000001} />)).toContain("0.00000001");
  expect(renderToString(<UsageTotal totalUsd={null} />)).toContain("not available");
});

test("voice picker includes provider voices and preserves an unlisted saved value", () => {
  const html = renderToString(<VoicePicker label="Host" value="old" voices={[{ id: "one", name: "Voice one" }]} onChange={() => {}} onPreview={() => {}} />);
  expect(html).toContain("Voice one");
  expect(html).toContain("old");
  expect(html).toContain("Preview");
});
