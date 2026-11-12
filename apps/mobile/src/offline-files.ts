import { Directory, File, Paths } from "expo-file-system";
import { EpisodeSchema, type Episode } from "shared";
import { saveOfflineEpisode } from "./offline-store";

const root = () => new Directory(Paths.document, "offline-episodes-v1");

let importing = false;
export async function importUsbEpisode(metadata: Pick<File, "json">, source: { copy(destination: File): Promise<void> }) {
  if (importing) throw new Error("An import is already in progress");
  importing = true;
  try {
    const episode = EpisodeSchema.parse(await metadata.json());
    if ((await listOfflineEpisodes()).some((row) => row.episode.id === episode.id)) {
      throw new Error("Episode already exists; replacements are not supported");
    }
    return await storeOfflineEpisode(episode, async (destination) => source.copy(destination));
  } finally {
    importing = false;
  }
}

// The caller supplies a trusted transport; pairing/credential handling is not implemented yet.
export async function storeOfflineEpisode(input: unknown, transfer: (destination: File) => Promise<void>) {
  const validated = EpisodeSchema.parse(input);
  const directory = root();
  directory.create({ idempotent: true, intermediates: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const staging = new Directory(directory, `staging-${name}`);
  const completed = new Directory(directory, `episode-${name}`);
  staging.create();
  const audio = new File(staging, "audio.m4a");
  let moved = false;
  return saveOfflineEpisode(validated, {
    async stage() {
      await transfer(audio);
      if (!audio.exists) throw new Error("Downloaded audio is missing");
      return { bytes: audio.size, sha256: await audio.digest("SHA-256") };
    },
    async publish(episode) {
      await new File(staging, "episode.json").write(JSON.stringify(episode));
      await staging.move(completed);
      moved = true;
    },
    discard() {
      if (!moved && staging.exists) staging.delete();
    },
  });
}

export async function listOfflineEpisodes(): Promise<{ episode: Episode; audioUri: string }[]> {
  const directory = root();
  if (!directory.exists) return [];
  const result: { episode: Episode; audioUri: string }[] = [];
  for (const item of directory.list()) {
    if (!(item instanceof Directory) || !item.name.startsWith("episode-")) continue;
    const episode = EpisodeSchema.parse(await new File(item, "episode.json").json());
    const audio = new File(item, "audio.m4a");
    if (!audio.exists || audio.size !== episode.audio.bytes || await audio.digest("SHA-256") !== episode.audio.sha256) {
      throw new Error("Stored episode audio failed verification");
    }
    result.push({ episode, audioUri: audio.uri });
  }
  return result;
}
