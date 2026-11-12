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

export function createSeekCheckpoint(playback: ReturnType<typeof offlinePlayback>, onSaveError: () => void = () => {}) {
  let generation = 0;
  let pending = false;
  let target: number | null = null;
  let queue = Promise.resolve();
  return {
    async seek(seconds: number, seek: () => Promise<void>, save = true) {
      const current = ++generation;
      pending = true;
      target = seconds;
      const operation = queue.then(() => current === generation ? seek() : undefined);
      queue = operation.catch(() => {});
      try {
        await operation;
      } catch (error) {
        if (current !== generation) return false;
        pending = false; target = null;
        throw error;
      }
      if (current !== generation) return false;
      pending = false;
      if (save) {
        try { playback.record(seconds, false); } catch { onSaveError(); }
      }
      return true;
    },
    acceptClock(seconds: number, finished: boolean) {
      if (pending) return false;
      if (target !== null) {
        if (finished || Math.abs(seconds - target) > 1) return false;
        target = null;
      }
      return true;
    },
  };
}
