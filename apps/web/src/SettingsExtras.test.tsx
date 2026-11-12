import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { UsageTotal, VoicePicker } from "./SettingsExtras.tsx";

test("usage displays the recorded UTC month total without rounding small costs to zero", () => {
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
