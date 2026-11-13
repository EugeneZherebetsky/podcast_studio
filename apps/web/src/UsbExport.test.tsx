import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { UsbExport } from "./UsbExport.tsx";

test("explains the two-file Android USB workflow for the selected episode", () => {
  const html = renderToString(<UsbExport id="episode 1" />);
  expect(html).toContain("/api/episodes/episode%201/usb/episode.json");
  expect(html).toContain("/api/episodes/episode%201/usb/audio.m4a");
  expect(html).toContain("Import USB package");
  expect(html).toContain("No automatic sync");
});
