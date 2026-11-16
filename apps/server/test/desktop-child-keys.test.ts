// Starts the real server entry point the way the desktop shell does (clean environment built
// by the shell's own `childEnvironment`, private IPC channel) with a synthetic key, and checks
// what the child does with it. An offline preload blocks every non-loopback connection.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { dropDesktopProviderKeys, PROVIDER_KEY_VARIABLES } from "../src/desktop-env.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

const KEY = "synthetic-fake-fish-key-child-0001";
type ChildEnvironment = (parent: object, resources: string, home: string, tools: null, piper: null, services: null, keys?: Record<string, string>) => Record<string, string>;
const shell = (): Promise<{ childEnvironment: ChildEnvironment }> => import(new URL("../../desktop/supervisor.mjs", import.meta.url).href);
const desktopKeyNames = async (): Promise<readonly string[]> => (await import(new URL("../../desktop/write-only-store.mjs", import.meta.url).href)).KEY_NAMES;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
}

async function runChild(keys: Record<string, string> | undefined, check: (origin: string, probe: () => Promise<string[]>) => Promise<void>): Promise<{ output: string; stored: string }> {
  const home = makeTempDir();
  const resources = path.join(home, "resources");
  cpSync(path.join("src", "db", "migrations"), path.join(resources, "server", "migrations"), { recursive: true });
  cpSync(path.join("src", "pipeline", "prompts"), path.join(resources, "server", "prompts"), { recursive: true });
  mkdirSync(path.join(resources, "web"), { recursive: true });
  writeFileSync(path.join(resources, "web", "index.html"), "desktop web root");
  const { childEnvironment } = await shell();
  const env = childEnvironment(process.env, resources, home, null, null, null, keys);
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/desktop-offline.mjs", "--import", "./test/fixtures/desktop-env-probe.mjs", "src/main.ts"], {
    cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", (data) => { output += String(data); });
  child.stderr!.on("data", (data) => { output += String(data); });
  try {
    expect(JSON.stringify(child.spawnargs)).not.toContain(KEY);
    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`desktop child did not start: ${output.replaceAll(KEY, "[key]")}`)), 20000);
      child.on("message", (message: { type?: string; port?: number }) => { if (message.type === "desktop-ready") { clearTimeout(timer); resolve({ port: message.port! }); } });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`desktop child exited: ${output.replaceAll(KEY, "[key]")}`)); });
    });
    const probe = () => new Promise<string[]>((resolve) => {
      child.on("message", (message: { type?: string; names?: string[] }) => { if (message.type === "env-probe") resolve(message.names!); });
      child.send("env-probe");
    });
    await check(`http://127.0.0.1:${ready.port}`, probe);
    const exit = once(child, "exit");
    child.stdin!.end();
    expect((await exit)[0]).toBe(0);
    return { output, stored: files(home).map((file) => readFileSync(file, "latin1")).join("\n") };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    removeTempDir(home);
  }
}

test("the server knows every key name the desktop store can hold", async () => {
  expect([...PROVIDER_KEY_VARIABLES].sort()).toEqual([...(await desktopKeyNames())].sort());
});

test("only a supervised desktop child drops provider keys from its own environment", () => {
  const desktop: NodeJS.ProcessEnv = { PODCAST_STUDIO_DESKTOP_IPC: "1", PATH: "path", ...Object.fromEntries(PROVIDER_KEY_VARIABLES.map((name) => [name, "synthetic"])) };
  dropDesktopProviderKeys(desktop);
  expect(desktop).toEqual({ PODCAST_STUDIO_DESKTOP_IPC: "1", PATH: "path" });
  const ordinary: NodeJS.ProcessEnv = { GOOGLE_GENERATIVE_AI_API_KEY: "synthetic", FISH_AUDIO_API_KEY: "synthetic" };
  dropDesktopProviderKeys(ordinary);
  expect(ordinary).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: "synthetic", FISH_AUDIO_API_KEY: "synthetic" });
});

test("an activated key reaches the real child's configuration and nothing else: not its output, storage, HTTP replies or later environment", async () => {
  let bodies = "";
  const { output, stored } = await runChild({ FISH_AUDIO_API_KEY: KEY }, async (origin, probe) => {
    const status = await fetch(`${origin}/api/settings/cloud-tts`);
    expect(await status.clone().json()).toEqual({ openaiConfigured: false, azureConfigured: false, elevenlabsConfigured: false, fishConfigured: true });
    for (const route of ["/api/settings/cloud-tts", "/api/settings", "/api/health", "/api/jobs", "/api/episodes", "/"]) {
      const response = await fetch(`${origin}${route}`);
      bodies += JSON.stringify([...response.headers.entries()]) + (await response.text());
    }
    const saved = await fetch(`${origin}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cloudTts: { provider: "fish", model: "s1", voice: "voice-id", inputLimit: 100 } }) });
    bodies += await saved.text();
    expect(saved.status).toBe(200);
    // What Piper or ffmpeg would inherit: the key was removed after the configuration was read.
    expect(await probe()).toEqual([]);
  });
  expect(bodies).toContain("fishConfigured");
  for (const sink of [output, stored, bodies]) {
    expect(sink).not.toContain(KEY);
    expect(sink).not.toContain(Buffer.from(KEY).toString("base64"));
  }
  expect(output).toContain("server listening");
}, 60000);

test("without activation the real child has no key", async () => {
  await runChild(undefined, async (origin, probe) => {
    expect(await (await fetch(`${origin}/api/settings/cloud-tts`)).json()).toEqual({ openaiConfigured: false, azureConfigured: false, elevenlabsConfigured: false, fishConfigured: false });
    expect(await probe()).toEqual([]);
  });
}, 60000);
