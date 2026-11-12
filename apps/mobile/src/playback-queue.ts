import { PlaybackPositionSchema, SyncPlaybackRequestSchema, type PlaybackPosition } from "shared";
import type { PlaybackQueue } from "./playback-sync";

const key = "pending-playback-v1";
type Storage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

export function playbackQueue(
  storage: Storage,
): PlaybackQueue & { record(position: PlaybackPosition): void } {
  const read = () =>
    SyncPlaybackRequestSchema.parse(JSON.parse(storage.getItemSync(key) ?? '{"positions":[]}'))
      .positions;
  const write = (positions: PlaybackPosition[]) =>
    storage.setItemSync(key, JSON.stringify({ positions }));
  return {
    pending: read,
    record(position) {
      const row = PlaybackPositionSchema.parse(position);
      const rows = read();
      const old = rows.find((item) => item.episodeId === row.episodeId);
      if (old && Date.parse(old.updatedAt) >= Date.parse(row.updatedAt)) return;
      write([...rows.filter((item) => item.episodeId !== row.episodeId), row]);
    },
    acknowledge(sent) {
      write(
        read().filter(
          (row) =>
            !sent.some(
              (item) =>
                item.episodeId === row.episodeId &&
                item.positionMs === row.positionMs &&
                item.finished === row.finished &&
                item.updatedAt === row.updatedAt,
            ),
        ),
      );
    },
  };
}
