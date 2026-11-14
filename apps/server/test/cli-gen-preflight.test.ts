import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase } from "../src/db/index.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("CLI hides unexpected provider exceptions while retaining job progress", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/cli-gen-failing-provider.ts", "Bees"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30000,
      env: { ...process.env, DATA_DIR: dir, PROFILE: "local", SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper", TTS_VOICE_NATIVE_HOST: "fake-voice" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Job /);
    expect(result.stderr).toMatch(/Generation failed/);
    expect(result.stdout + result.stderr).not.toContain("synthetic-provider-secret-47");
  } finally { removeTempDir(dir); }
});

test("smoke output hides unexpected local provider exceptions", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/cli-smoke-failing-provider.ts", "--only", "search"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30000,
      env: { ...process.env, DATA_DIR: dir, PROFILE: "local", SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/unreachable\/skipped/);
    expect(result.stdout + result.stderr).not.toContain("synthetic-smoke-secret-52");
  } finally { removeTempDir(dir); }
});

test("server startup hides configuration filesystem exceptions", () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, "synthetic-startup-secret-64");
    mkdirSync(path.join(home, ".env"), { recursive: true });
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30000,
      env: { ...process.env, PODCAST_STUDIO_HOME: home, PODCAST_STUDIO_DESKTOP_IPC: "0" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/configuration/i);
    expect(result.stdout + result.stderr).not.toContain("synthetic-startup-secret-64");
  } finally { removeTempDir(dir); }
});

test("manual draft hides filesystem exception paths", () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/manual-draft.ts", "import", "job", "prepared", path.join(dir, "synthetic-manual-secret-75")], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30000,
      env: { ...process.env, DATA_DIR: dir, PROFILE: "local" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("synthetic-manual-secret-75");
  } finally { removeTempDir(dir); }
});

test("CLI preserves ownership and manual recovery warnings", () => {
  const dir = makeTempDir();
  const env = { ...process.env, DATA_DIR: dir, PROFILE: "local", SEARCH_PROVIDER: "searxng", TTS_PROVIDER: "piper", TTS_VOICE_NATIVE_HOST: "fake-voice" };
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "src/cli/gen.ts", "Bees"], {
    cwd: process.cwd(), encoding: "utf8", env, timeout: 30000,
  });
  try {
    const guard = openDesktopGuard(dir);
    try {
      const locked = run();
      expect(locked.status).toBe(1);
      expect(locked.stderr).toMatch(/Another desktop generation server owns/);
      guard.begin();
    } finally { guard.close(false); }
    const dirty = run();
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/Unclean desktop generation is unresolved.*manual recovery/);
  } finally { removeTempDir(dir); }
});

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
