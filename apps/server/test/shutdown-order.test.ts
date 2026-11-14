import { request } from "node:http";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";
import { createScriptSelection } from "../src/chatgpt-selection.ts";
import { openDatabase } from "../src/db/index.ts";
import { EventEmitter } from "node:events";
import { createDesktopRunner } from "../src/desktop-runner.ts";
import { createFakeProviders } from "../src/providers/index.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";
import { registerRunnerShutdown } from "../src/shutdown.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("session shutdown starts while a real models HTTP request is stalled", async () => {
  const dir = makeTempDir();
  const db = openDatabase(path.join(dir, "app.db"));
  let release!: (response: Response) => void;
  let started!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>((resolve) => { release = resolve; }); }));
  const revoke = vi.fn(async () => "revoked" as const);
  const session = await createChatGptSession(path.join(dir, "session"), async () => ({
    authorizationUrl: "https://example.test", close() {}, result: Promise.resolve({ kind: "success" as const, subject: "sub", clientId: "client", accessToken: "fixture", refreshToken: "fixture", idToken: "fixture", expiresIn: 60, scopes: [], planEnabled: true }),
  }), revoke);
  await (await session.login("work")).complete();
  let workStarted!: () => void;
  const workReady = new Promise<void>((resolve) => { workStarted = resolve; });
  let endWork!: () => void;
  const work = new Promise<void>((resolve) => { endWork = resolve; });
  const fake = createFakeProviders({ wavDir: path.join(dir, "wav") });
  const events = new EventEmitter();
  const runner = createDesktopRunner({ db, providers: { ...fake, llm: { async generateObject() { workStarted(); await work; throw new Error("fixture stopped"); } } }, dataDir: dir, budgetUsd: 20, voice: "fixture", profile: "local", llmName: "fake", ttsName: "fake", nativeLang: "en" }, events);
  const app = buildApp({ db, runner, events, chatgptSession: session, scriptSelection: createScriptSelection(path.join(dir, "selection"), session) });
  registerRunnerShutdown(app, db, runner);
  await runner.create({ title: "Bees", brief: "", mode: "standard", lang: "en", minutes: 1 });
  await workReady;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const response = new Promise<void>((resolve, reject) => {
    const req = request(`${origin}/api/chatgpt/models`, { method: "POST", headers: { origin } }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject); req.end();
  });
  await upstreamStarted;
  const closing = app.close();
  const closingAgain = app.close();
  try {
    await vi.waitFor(() => expect(revoke).toHaveBeenCalled(), { timeout: 1000 });
    expect(session.status().active).toBeNull();
    await vi.waitFor(() => expect(db.$client.prepare("select status from jobs").get()).toMatchObject({ status: "cancelled" }), { timeout: 1000 });
    await expect(runner.create({ title: "Later", brief: "", mode: "standard", lang: "en", minutes: 1 })).rejects.toThrow(/shutting down/i);
    expect(app.server.listening).toBe(false);
  } finally {
    endWork();
    release(Response.json({ models: [] }));
    await response;
    await Promise.all([closing, closingAgain]);
    expect(revoke).toHaveBeenCalledTimes(2); // access and refresh tokens, once each
    const guard = openDesktopGuard(dir);
    try { expect(() => guard.begin()).toThrow(/manual recovery/i); } finally { guard.close(false); }
    vi.unstubAllGlobals();
    removeTempDir(dir);
  }
}, 10000);
