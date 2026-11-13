import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScriptSelection } from "../src/chatgpt-selection.ts";

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
