import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { openDesktopGuard } from "../src/desktop-guard.ts";

test("clean closure clears only this process's marker, never a prior unclean one", () => {
  const dir = makeTempDir();
  try {
    const first = openDesktopGuard(dir);
    first.begin();
    first.close(true);
    const second = openDesktopGuard(dir);
    second.begin();
    second.close(false);
    const third = openDesktopGuard(dir);
    expect(() => third.begin()).toThrow(/manual/i);
    third.close(true);
    const fourth = openDesktopGuard(dir);
    expect(() => fourth.begin()).toThrow(/manual/i);
    fourth.close(false);
  } finally { removeTempDir(dir); }
});

test("a crash releases the cross-process lock but leaves an unclean marker", async () => {
  const dir = makeTempDir();
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/desktop-guard-child.ts", dir], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout, "data");
    expect(() => openDesktopGuard(dir)).toThrow(/another/i);
    child.kill("SIGKILL");
    await once(child, "exit");
    const guard = openDesktopGuard(dir);
    try {
      expect(() => guard.begin()).toThrow(/manual/i);
    } finally { guard.close(false); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    removeTempDir(dir);
  }
}, 15_000);
