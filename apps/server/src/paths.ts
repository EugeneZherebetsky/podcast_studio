import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const CONFIG_ROOT = Symbol("configuration root");
type Rooted = { [CONFIG_ROOT]?: string };

export function configRoot(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.PODCAST_STUDIO_HOME?.trim() ? env.PODCAST_STUDIO_HOME : REPO_ROOT);
}

export function rootForConfig(config: object): string {
  return (config as Rooted)[CONFIG_ROOT] ?? configRoot();
}

function resourcePath(packaged: string[], repository: string[]): string {
  const root = process.env.PODCAST_STUDIO_RESOURCES;
  return root?.trim() ? path.resolve(root, ...packaged) : path.join(REPO_ROOT, ...repository);
}

export const webRoot = () => resourcePath(["web"], ["apps", "web", "dist"]);
export const migrationsDir = () =>
  resourcePath(["server", "migrations"], ["apps", "server", "src", "db", "migrations"]);
export const promptsDir = () =>
  resourcePath(["server", "prompts"], ["apps", "server", "src", "pipeline", "prompts"]);
export const ffmpegPath = () =>
  process.env.FFMPEG_PATH?.trim() ? process.env.FFMPEG_PATH : "ffmpeg";
export const ffprobePath = () =>
  process.env.FFPROBE_PATH?.trim() ? process.env.FFPROBE_PATH : "ffprobe";
