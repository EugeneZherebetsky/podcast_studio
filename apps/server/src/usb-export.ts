import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { EpisodeSchema } from "shared";

export async function exportUsbEpisode(source: string, destination: string): Promise<void> {
  const sourceDir = await realpath(source);
  const destinationParent = await realpath(path.dirname(path.resolve(destination)));
  const relative = path.relative(sourceDir, destinationParent);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Destination must be outside the source package");
  }
  for (const name of ["episode.json", "audio.m4a"]) {
    if (!(await lstat(path.join(sourceDir, name))).isFile())
      throw new Error("Invalid package file");
  }
  const metadata = await readFile(path.join(sourceDir, "episode.json"));
  const episode = EpisodeSchema.parse(JSON.parse(metadata.toString("utf8")));
  await mkdir(destination);
  const outputAudio = path.join(destination, "audio.m4a");
  await copyFile(path.join(sourceDir, "audio.m4a"), outputAudio, constants.COPYFILE_EXCL);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(outputAudio)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  if (bytes !== episode.audio.bytes || hash.digest("hex") !== episode.audio.sha256) {
    throw new Error("Audio integrity verification failed");
  }
  const outputMetadata = path.join(destination, "episode.json");
  await writeFile(outputMetadata, metadata, { flag: "wx" });
  if (!(await readFile(outputMetadata)).equals(metadata)) {
    throw new Error("Metadata verification failed");
  }
}
