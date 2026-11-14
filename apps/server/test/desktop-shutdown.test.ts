import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { openDatabase } from "../src/db/index.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("opted-in server closes on parent stdin EOF", async () => {
  const dir = makeTempDir();
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DATA_DIR: dir, PODCAST_STUDIO_HOME: dir, PORT: String(port), PODCAST_STUDIO_PARENT_STDIN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (data) => { errors += String(data); });
  try {
    const ready = await once(child.stdout, "data");
    expect(String(ready[0])).toContain("server listening");
    const exit = once(child, "exit");
    child.stdin.end();
    const result = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`shutdown timed out: ${errors}`)), 6000))]);
    expect(result[0]).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    removeTempDir(dir);
  }
}, 15000);

test("ordinary server ignores stdin EOF without opt-in", async () => {
  const dir = makeTempDir();
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DATA_DIR: dir, PODCAST_STUDIO_HOME: dir, PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await once(child.stdout, "data");
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBeGreaterThan(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    removeTempDir(dir);
  }
}, 15000);

test("a stuck close exits nonzero at the shutdown deadline", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-stuck-child.ts"], {
    cwd: process.cwd(), env: { ...process.env, PODCAST_STUDIO_PARENT_STDIN: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await once(child.stdout, "data");
    const exit = once(child, "exit");
    child.stdin.end();
    const result = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown deadline failed")), 11000))]);
    expect(result[0]).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
  }
}, 15000);

test("forced exit during HTTP drain retains the generation recovery marker", async () => {
  const dir = makeTempDir();
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-http-child.ts", dir], {
    cwd: process.cwd(), env: { ...process.env, PODCAST_STUDIO_PARENT_STDIN: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let req: ReturnType<typeof request> | undefined;
  try {
    const ready = String((await lines.next()).value);
    expect(ready).toMatch(/^READY \d+$/);
    req = request(`http://127.0.0.1:${ready.split(" ")[1]}/stalled`);
    req.on("error", () => {});
    req.end();
    expect((await lines.next()).value).toBe("STALLED");
    const exit = once(child, "exit");
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => { const probe = openDesktopGuard(dir); probe.close(false); }).toThrow(/another/i);
    const result = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown deadline failed")), 11000))]);
    expect(result[0]).toBe(1);
    const guard = openDesktopGuard(dir);
    try { expect(() => guard.begin()).toThrow(/manual recovery/i); } finally { guard.close(false); }
  } finally {
    req?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    removeTempDir(dir);
  }
}, 15000);

test("active fake process survives bounded shutdown and durable guard blocks another generation", async () => {
  const dir = makeTempDir();
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-job-child.ts", dir], {
    cwd: process.cwd(), env: { ...process.env, PODCAST_STUDIO_PARENT_STDIN: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let worker = 0;
  let errors = "";
  child.stderr.on("data", (data) => { errors += String(data); });
  try {
    const output = String((await once(child.stdout, "data"))[0]);
    worker = Number(/WORKER (\d+)/.exec(output)?.[1]);
    expect(worker).toBeGreaterThan(0);
    const exit = once(child, "exit");
    const started = Date.now();
    child.stdin.end();
    const result = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 6000))]);
    expect(result[0]).toBe(1);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(() => process.kill(worker, 0), errors).not.toThrow();
    const db = openDatabase(path.join(dir, "app.db"));
    try {
      db.$client.exec("BEGIN IMMEDIATE; ROLLBACK");
      expect(db.$client.prepare("select status from jobs").get()).toMatchObject({ status: "cancelled" });
    } finally { db.$client.close(); }
    const guard = openDesktopGuard(dir);
    try { expect(() => guard.begin()).toThrow(/manual recovery/i); } finally { guard.close(false); }
    const reopened = openDatabase(path.join(dir, "app.db"));
    const runner = createDesktopRunner({ db: reopened, providers: createFakeProviders({ wavDir: path.join(dir, "wav") }), dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, new EventEmitter());
    try {
      await expect(runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 })).rejects.toThrow(/manual recovery/i);
      expect(reopened.$client.prepare("select count(*) as n from jobs").get()).toMatchObject({ n: 1 });
    } finally { await runner.close(); reopened.$client.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    if (worker) { try { process.kill(worker); } catch { /* already exited */ } }
    removeTempDir(dir);
  }
}, 15000);
