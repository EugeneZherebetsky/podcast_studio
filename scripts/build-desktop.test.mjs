import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("existing output blocks a build before copying and preserves stale files", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "desktop-build-test-"));
  await mkdir(path.join(fixture, "scripts"));
  await cp(path.join(root, "scripts/build-desktop.mjs"), path.join(fixture, "scripts/build-desktop.mjs"));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  const out = path.join(fixture, "dist-desktop");
  await mkdir(out);
  await writeFile(path.join(out, "stale.txt"), "keep me");
  const result = spawnSync(process.execPath, [path.join(fixture, "scripts/build-desktop.mjs")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(await readdir(out), ["stale.txt"]);
  assert.equal(await readFile(path.join(out, "stale.txt"), "utf8"), "keep me");
});

test("test bundle cannot overwrite an existing file or enter the production output", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "desktop-fake-test-"));
  const existing = path.join(fixture, "existing.mjs");
  await writeFile(existing, "keep me");
  await mkdir(path.join(fixture, "scripts"));
  await cp(path.join(root, "scripts/build-desktop.mjs"), path.join(fixture, "scripts/build-desktop.mjs"));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  await mkdir(path.join(fixture, "dist-desktop"));
  const script = path.join(fixture, "scripts/build-desktop.mjs");
  const collision = spawnSync(process.execPath, [script, "--test-output", existing], { encoding: "utf8" });
  assert.notEqual(collision.status, 0);
  assert.equal(await readFile(existing, "utf8"), "keep me");

  const alias = path.join(fixture, "alias");
  await symlink(path.join(fixture, "dist-desktop"), alias, "junction");
  const inside = spawnSync(process.execPath, [script, "--test-output", path.join(alias, "fake.mjs")], { encoding: "utf8" });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /Test bundles must be outside dist-desktop/);
});
