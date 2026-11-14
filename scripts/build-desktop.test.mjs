import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
  assert.match(result.stderr, process.versions.node.split(".")[0] === "22" ? /already exists/ : /Node 22 runtime/);
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

test("test bundles cannot be planted in copied web input", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "desktop-web-input-"));
  await mkdir(path.join(fixture, "scripts"));
  await cp(path.join(root, "scripts/build-desktop.mjs"), path.join(fixture, "scripts/build-desktop.mjs"));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  const web = path.join(fixture, "apps/web/dist");
  await mkdir(web, { recursive: true });
  await writeFile(path.join(web, "keep.txt"), "keep me");
  const alias = path.join(fixture, "web-alias");
  await symlink(web, alias, "junction");
  const result = spawnSync(process.execPath, [path.join(fixture, "scripts/build-desktop.mjs"), "--test-output", path.join(alias, "fake.mjs")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Test bundles must be outside/);
  assert.deepEqual(await readdir(web), ["keep.txt"]);
  assert.equal(await readFile(path.join(web, "keep.txt"), "utf8"), "keep me");

  const external = await mkdtemp(path.join(os.tmpdir(), "desktop-linked-input-"));
  await writeFile(path.join(external, "keep.txt"), "untouched");
  await symlink(external, path.join(web, "linked"), "junction");
  const linked = spawnSync(process.execPath, [path.join(fixture, "scripts/build-desktop.mjs"), "--test-output", path.join(external, "fake.mjs")], { encoding: "utf8" });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /Test bundles must be outside production inputs/);
  assert.deepEqual(await readdir(external), ["keep.txt"]);
  assert.equal(await readFile(path.join(external, "keep.txt"), "utf8"), "untouched");
});

test("test bundles cannot enter a copied runtime package", async () => {
  const require = createRequire(path.join(root, "apps/server/package.json"));
  const packageDir = path.dirname(require.resolve("linkedom"));
  const before = await readdir(packageDir);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/build-desktop.mjs"), "--test-output", path.join(packageDir, "fake-test-bundle.mjs")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Test bundles must be outside production inputs/);
  assert.deepEqual(await readdir(packageDir), before);
});

test("an isolated fake bundle builds on the current supported Node", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "desktop-real-fake-"));
  const output = path.join(fixture, "fake.mjs");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/build-desktop.mjs"), "--test-output", output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(output)).length > 0);
});
