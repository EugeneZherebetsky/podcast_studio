import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh directory under the OS temp dir; tests never touch the repo's ./data. */
export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "podcast-studio-test-"));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
