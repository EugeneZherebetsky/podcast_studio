import Database from "better-sqlite3";
import path from "node:path";

/** Separate SQLite files provide a crash-released mutex and a durable dirty bit. */
export function openDesktopGuard(root: string) {
  const lock = new Database(path.join(root, "desktop-generation-lock.sqlite"), { timeout: 0 });
  try {
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY")
      throw new Error("Another desktop generation server owns this data directory", { cause: error });
    throw error;
  }
  let marker: Database.Database;
  try {
    marker = new Database(path.join(root, "desktop-generation-state.sqlite"));
    marker.pragma("synchronous = FULL");
    marker.exec("CREATE TABLE IF NOT EXISTS state (dirty INTEGER NOT NULL)");
  } catch (error) {
    lock.close();
    throw error;
  }
  const unresolved = !!marker.prepare("SELECT 1 FROM state LIMIT 1").get();
  let dirty = false;
  let closed = false;
  return {
    begin() {
      if (unresolved) throw new Error("Unclean desktop generation is unresolved. Stop all servers and verify any Piper, ffmpeg and Ollama work has stopped; see SETUP.md for manual recovery.");
      if (!dirty) {
        marker.prepare("INSERT INTO state (dirty) VALUES (1)").run();
        dirty = true;
      }
    },
    close(clean: boolean) {
      if (closed) return;
      if (clean && dirty) marker.exec("DELETE FROM state");
      marker.close();
      lock.close();
      closed = true;
    },
  };
}
