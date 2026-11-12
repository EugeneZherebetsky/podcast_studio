import { playbackQueue } from "./playback-queue";

const positionKey = "sample-position-seconds";
const localQueueKey = "sample-local-playback-v1";
type Storage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

// The bundled fixture has no server episode; never mix it with the sync queue.
export function samplePlayback(storage: Storage, episodeId: string) {
  const queue = playbackQueue({
    getItemSync: () => storage.getItemSync(localQueueKey),
    setItemSync: (_key, value) => storage.setItemSync(localQueueKey, value),
  });
  return {
    position() {
      const raw = storage.getItemSync(positionKey);
      const value = raw === null ? 0 : Number(raw);
      if (raw === "" || !Number.isFinite(value) || value < 0) throw new Error("Invalid saved position");
      return value;
    },
    pending: queue.pending,
    record(seconds: number, finished: boolean, updatedAt = new Date().toISOString()) {
      storage.setItemSync(positionKey, String(finished ? 0 : seconds));
      queue.record({
        episodeId,
        positionMs: Math.max(0, Math.round(seconds * 1000)),
        finished,
        updatedAt,
      });
    },
  };
}
