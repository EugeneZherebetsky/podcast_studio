import { exportUsbEpisode } from "../usb-export.ts";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error("Usage: pnpm usb:export <existing-package-directory> <new-export-directory>");
  process.exitCode = 1;
} else {
  try {
    await exportUsbEpisode(source, destination);
    console.log(
      "Export verified. Copy episode.json and audio.m4a to the phone and import both in Library.",
    );
  } catch {
    console.error(
      "Export failed. Check the package, destination and permissions. Any new destination may be incomplete; use a new directory to retry.",
    );
    process.exitCode = 1;
  }
}
