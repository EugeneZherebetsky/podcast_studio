import { EpisodeSchema, type Episode } from "shared";

type Staging = {
  stage(): Promise<{ bytes: number; sha256: string }>;
  publish(episode: Episode): Promise<void>;
  discard(): void;
};

// Transport must be provided by the future authenticated pairing implementation.
export async function saveOfflineEpisode(input: unknown, io: Staging): Promise<Episode> {
  const episode = EpisodeSchema.parse(input);
  try {
    const audio = await io.stage();
    if (audio.bytes !== episode.audio.bytes || audio.sha256 !== episode.audio.sha256) {
      throw new Error("Audio verification failed");
    }
    await io.publish(episode);
    return episode;
  } catch (error) {
    io.discard();
    throw error;
  }
}
