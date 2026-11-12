import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { exportUsbEpisode } from "../src/usb-export.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("CLI exports an existing package", async () => {
  const root = makeTempDir();
  try {
    const cli = new URL("../src/cli/usb-export.ts", import.meta.url);
    const sample = new URL("../../mobile/assets/", import.meta.url);
    const destination = path.join(root, "export");
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    await promisify(execFile)(process.execPath, [
      tsx,
      fileURLToPath(cli),
      fileURLToPath(sample),
      destination,
    ]);
    expect(await readFile(path.join(destination, "episode.json"))).toEqual(
      await readFile(new URL("episode.json", sample)),
    );
  } finally {
    removeTempDir(root);
  }
}, 30000);

test("exports exact metadata and verified audio without replacing existing destinations", async () => {
  const root = makeTempDir();
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "export");
    await mkdir(source);
    const sample = new URL("../../mobile/assets/", import.meta.url);
    for (const file of ["episode.json", "audio.m4a"])
      await copyFile(new URL(file, sample), path.join(source, file));
    const metadata = await readFile(path.join(source, "episode.json"));
    const audio = await readFile(path.join(source, "audio.m4a"));
    await exportUsbEpisode(source, destination);
    expect(await readFile(path.join(destination, "episode.json"))).toEqual(metadata);
    expect(await readFile(path.join(destination, "audio.m4a"))).toEqual(audio);
    await expect(exportUsbEpisode(source, destination)).rejects.toThrow();
    expect(await readFile(path.join(destination, "audio.m4a"))).toEqual(audio);
    await writeFile(path.join(source, "audio.m4a"), "corrupt");
    const bad = path.join(root, "bad");
    await expect(exportUsbEpisode(source, bad)).rejects.toThrow();
    await expect(readFile(path.join(bad, "episode.json"))).rejects.toThrow();
    await expect(exportUsbEpisode(source, path.join(source, "nested"))).rejects.toThrow();
    await writeFile(path.join(source, "episode.json"), "{}");
    await expect(exportUsbEpisode(source, path.join(root, "invalid"))).rejects.toThrow();
    await expect(readFile(path.join(root, "invalid", "episode.json"))).rejects.toThrow();
  } finally {
    removeTempDir(root);
  }
}, 30000);
