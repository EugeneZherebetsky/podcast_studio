import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDatabase } from "../src/db/index.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("CLI missing voice leaves no job or dirty marker", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/gen.ts", "Bees"], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, DATA_DIR: dir, PROFILE: "local", SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper", TTS_VOICE_NATIVE_HOST: "" },
    });
    expect(result.stderr).toMatch(/TTS_VOICE_NATIVE_HOST/);
    const db = openDatabase(path.join(dir, "app.db"));
    try { expect(db.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 0 }); } finally { db.$client.close(); }
    const guard = openDesktopGuard(dir);
    try { expect(() => guard.begin()).not.toThrow(); } finally { guard.close(true); }
  } finally { removeTempDir(dir); }
});
