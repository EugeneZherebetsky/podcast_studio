import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import { registerRunnerShutdown } from "../src/shutdown.ts";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "ownership-test-"));
}

test("a rejected desktop startup does not open the application database or ChatGPT store", async () => {
  const dir = tempDir();
  const guard = openDesktopGuard(dir);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DATA_DIR: dir, PODCAST_STUDIO_HOME: dir, PROFILE: "local", HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (data) => { errors += String(data); });
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(errors).toContain("Another desktop generation server owns");
    expect(existsSync(path.join(dir, "app.db"))).toBe(false);
    expect(existsSync(path.join(dir, "chatgpt", "chatgpt-registration.json"))).toBe(false);
  } finally { guard.close(false); }
}, 30000);

test("desktop ownership remains held until ChatGPT shutdown finishes", async () => {
  const dir = tempDir();
  const db = openDatabase(path.join(dir, "app.db"));
  const runner = createDesktopRunner({ db, providers: createFakeProviders({ wavDir: path.join(dir, "wav") }), dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, new EventEmitter());
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const session = await createChatGptSession(path.join(dir, "chatgpt"), async () => ({
    authorizationUrl: "https://example.test", close() {}, result: Promise.resolve({ kind: "success" as const, subject: "sub", clientId: "client", accessToken: "fixture", refreshToken: "fixture", idToken: "fixture", expiresIn: 60, scopes: [], planEnabled: true }),
  }), async () => { started(); await waiting; return "revoked"; });
  await (await session.login("work")).complete();
  const app = buildApp({ db, runner, chatgptSession: session });
  registerRunnerShutdown(app, db, runner, session);
  await app.ready();
  const closing = app.close();
  try {
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => { const probe = openDesktopGuard(dir); probe.close(false); }).toThrow(/another/i);
  } finally {
    release();
    await closing;
  }
  const guard = openDesktopGuard(dir);
  guard.close(false);
}, 10000);

test("session shutdown failure does not release desktop ownership", async () => {
  const dir = tempDir();
  const db = openDatabase(path.join(dir, "app.db"));
  const runner = createDesktopRunner({ db, providers: createFakeProviders({ wavDir: path.join(dir, "wav") }), dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, new EventEmitter());
  const session = { shutdown: async () => { throw new Error("shutdown failed"); } };
  const app = buildApp({ db, runner });
  registerRunnerShutdown(app, db, runner, session);
  await app.ready();
  try {
    await expect(app.close()).rejects.toThrow("shutdown failed");
    expect(db.$client.open).toBe(true);
    expect(() => { const probe = openDesktopGuard(dir); probe.close(false); }).toThrow(/another/i);
  } finally {
    await runner.close();
    db.$client.close();
  }
});
