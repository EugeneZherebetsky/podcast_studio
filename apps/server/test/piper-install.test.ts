import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";
import { REPO_ROOT } from "../src/config.ts";

test("voice download requires explicit license opt-in before accessing network", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/piper-voices.mjs"], { cwd: REPO_ROOT, stdio: "pipe" }),
  ).toThrow(/accept-licenses/);
});

test("voice download refuses to overwrite a modified existing model", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(path.join(dir, "voices"));
    const model = path.join(dir, "voices", "en_US-lessac-medium.onnx");
    writeFileSync(model, "keep this");
    expect(() =>
      execFileSync(process.execPath, ["scripts/piper-voices.mjs", "--accept-licenses", dir], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      }),
    ).toThrow(/not overwritten/);
    expect(readFileSync(model, "utf8")).toBe("keep this");
  } finally {
    removeTempDir(dir);
  }
});
