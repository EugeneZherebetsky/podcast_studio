import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Transcript } from "./Transcript.tsx";

const segments = [
  {
    id: "a",
    kind: "content" as const,
    speaker: "host" as const,
    lang: "en",
    text: "First",
    startMs: 0,
    endMs: 1000,
  },
  {
    id: "b",
    kind: "content" as const,
    speaker: "host" as const,
    lang: "en",
    text: "Second",
    startMs: 1500,
    endMs: 2000,
  },
];

test("highlights only the segment containing the playback position", () => {
  expect(
    renderToStaticMarkup(<Transcript segments={segments} positionMs={1500} onSeek={() => {}} />),
  ).toMatch(/aria-current="true"[^>]*>.*Second/);
  expect(
    renderToStaticMarkup(<Transcript segments={segments} positionMs={1000} onSeek={() => {}} />),
  ).not.toContain("aria-current");
  expect(
    renderToStaticMarkup(<Transcript segments={segments} positionMs={2000} onSeek={() => {}} />),
  ).not.toContain("aria-current");
});
