import { EpisodeSchema } from "shared";
import metadata from "../assets/episode.json";

export const sampleEpisode = EpisodeSchema.parse(metadata);
