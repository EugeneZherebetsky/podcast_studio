import { fork } from "node:child_process";
import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScriptSelection, ScriptPreflightError } from "../src/chatgpt-selection.ts";

it("honors local opt-out saved by another process before sending", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-process-"));
  const generateStructured = vi.fn(async () => "{}");
  const session = { status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }), models: async () => [{ slug: "chosen", display_name: "Chosen" }], generateStructured };
  try {
    const selection = createScriptSelection(dir, session);
    await selection.set({ provider: "chatgpt", model: "chosen" });
    const generator = selection.generator()!;
    const child = fork(path.join(import.meta.dirname, "fixtures", "chatgpt-selection-local.ts"), [dir], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
    });
    expect(selection.get()).toEqual({ provider: "local" });
    await expect(generator.run({} as never)).rejects.toThrow(/selection changed/i);
    expect(generateStructured).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("marks invalid script input settled without making a request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-validation-"));
  const generateStructured = vi.fn(async () => "{}");
  const session = { status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }), models: async () => [{ slug: "chosen", display_name: "Chosen" }], generateStructured };
  try {
    const selection = createScriptSelection(dir, session);
    await selection.set({ provider: "chatgpt", model: "chosen" });
    await expect(selection.generator()!.run({} as never)).rejects.toBeInstanceOf(ScriptPreflightError);
    expect(generateStructured).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("requires explicit account and model selection and never falls back after session loss", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-"));
  let active: string | null = "alice";
  let expired = false;
  const session = {
    status: () => ({ active, expired, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: vi.fn(async () => [{ slug: "chosen", display_name: "Chosen" }]),
    generateStructured: vi.fn(async () => "{}"),
  };
  try {
    const selection = createScriptSelection(dir, session);
    expect(selection.get()).toEqual({ provider: "local" });
    await expect(selection.set({ provider: "chatgpt", model: "other" })).rejects.toThrow();
    await selection.set({ provider: "chatgpt", model: "chosen" });
    expect(selection.get()).toEqual({ provider: "chatgpt", model: "chosen", account: "alice" });
    expect(selection.generator()?.identity).toContain("chosen");
    expired = true;
    expect(() => selection.generator()).toThrow(/sign/i);
    expired = false;
    active = null;
    expect(() => selection.generator()).toThrow(/sign/i);
    active = "bob";
    expect(() => selection.generator()).toThrow(/sign/i);
    await selection.set({ provider: "local" });
    expect(selection.generator()).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("keeps the later local selection when an earlier catalog request finishes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-race-"));
  let resolveModels!: (value: { slug: string; display_name: string }[]) => void;
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: () => new Promise<{ slug: string; display_name: string }[]>((resolve) => { resolveModels = resolve; }),
    generateStructured: async () => "{}",
  };
  try {
    const selection = createScriptSelection(dir, session);
    const older = selection.set({ provider: "chatgpt", model: "chosen" });
    await createScriptSelection(dir, session).set({ provider: "local" });
    resolveModels([{ slug: "chosen", display_name: "Chosen" }]);
    await expect(older).rejects.toThrow(/superseded/i);
    expect(selection.get()).toEqual({ provider: "local" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("rejects a queued generator after the user switches to local before sending", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-queued-"));
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: vi.fn(async () => "{}"),
  };
  try {
    const selection = createScriptSelection(dir, session);
    await selection.set({ provider: "chatgpt", model: "chosen" });
    const generator = selection.generator()!;
    await selection.set({ provider: "local" });
    await expect(generator.run({} as never)).rejects.toThrow(/selection changed/i);
    expect(session.generateStructured).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("keeps the later ChatGPT choice when model catalogs finish out of order", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-two-"));
  const pending: ((value: { slug: string; display_name: string }[]) => void)[] = [];
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: () => new Promise<{ slug: string; display_name: string }[]>((resolve) => pending.push(resolve)),
    generateStructured: async () => "{}",
  };
  try {
    const selection = createScriptSelection(dir, session);
    const older = selection.set({ provider: "chatgpt", model: "one" });
    const newer = selection.set({ provider: "chatgpt", model: "two" });
    pending[1]!([{ slug: "two", display_name: "Two" }]);
    await newer;
    pending[0]!([{ slug: "one", display_name: "One" }]);
    await expect(older).rejects.toThrow(/superseded/i);
    expect(selection.get()).toEqual({ provider: "chatgpt", model: "two", account: "alice" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("fails closed when a saved ChatGPT selection has no session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-offline-"));
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => [{ slug: "chosen", display_name: "Chosen" }],
    generateStructured: async () => "{}",
  };
  try {
    await createScriptSelection(dir, session).set({ provider: "chatgpt", model: "chosen" });
    expect(() => createScriptSelection(dir).generator()).toThrow(/unavailable/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("fails closed after a selection is interrupted or rejected until a new choice is saved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-incomplete-"));
  const session = {
    status: () => ({ active: "alice", expired: false, planEnabled: true, accounts: [], remoteUncertain: false, uncertain: [] }),
    models: async () => { throw new Error("catalog unavailable"); },
    generateStructured: async () => "{}",
  };
  try {
    const selection = createScriptSelection(dir, session);
    await expect(selection.set({ provider: "chatgpt", model: "chosen" })).rejects.toThrow(/catalog/);
    expect(selection.get()).toEqual({ provider: "incomplete" });
    expect(() => selection.generator()).toThrow(/incomplete/i);
    await selection.set({ provider: "local" });
    expect(selection.generator()).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
