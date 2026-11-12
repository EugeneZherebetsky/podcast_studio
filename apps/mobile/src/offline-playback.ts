type Storage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

// Separate from all server synchronization queues.
export function offlinePlayback(storage: Storage, episodeId: string) {
  const key = `offline-position-v1:${episodeId}`;
  return {
    position() {
      const raw = storage.getItemSync(key);
      const value = raw === null ? 0 : Number(raw);
      if (raw === "" || !Number.isFinite(value) || value < 0) throw new Error("Invalid saved position");
      return value;
    },
    record(seconds: number, finished: boolean) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid position");
      storage.setItemSync(key, String(finished ? 0 : seconds));
    },
  };
}
