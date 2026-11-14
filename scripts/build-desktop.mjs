import { build } from "esbuild";
import { cp, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-desktop");
const server = path.join(out, "server");
const testOutput =
  process.argv[2] === "--test-output" && process.argv[3]
    ? path.resolve(process.argv[3])
    : undefined;
if (process.argv.length > 2 && (!testOutput || process.argv.length !== 4))
  throw new Error("Usage: node scripts/build-desktop.mjs [--test-output <isolated-file>]");
if (!testOutput && process.versions.node.split(".")[0] !== "22")
  throw new Error("Build with the project's Node 22 runtime");

async function packageDirectory(name, from) {
  const requireFrom = createRequire(path.join(from, "package.json"));
  let dir = path.dirname(await realpath(requireFrom.resolve(name)));
  for (;;) {
    try {
      const meta = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      if (meta.name === name) return { dir, meta };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate package ${name}`);
    dir = parent;
  }
}

if (testOutput) {
  const destination = path.join(await realpath(path.dirname(testOutput)), path.basename(testOutput));
  const production = await realpath(out).catch((error) => {
    if (error.code === "ENOENT") return path.join(root, "dist-desktop");
    throw error;
  });
  const relative = path.relative(production, destination);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    throw new Error("Test bundles must be outside dist-desktop");
  const seen = new Set();
  async function checkTree(dir) {
    let physical;
    try {
      physical = await realpath(dir);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const rel = path.relative(physical, destination);
    if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)))
      throw new Error("Test bundles must be outside production inputs");
    if (seen.has(physical)) return;
    seen.add(physical);
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      const child = path.join(physical, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(child)).isDirectory()))
        await checkTree(child);
    }
  }
  for (const input of ["apps/web/dist", "apps/server/src/db/migrations", "apps/server/src/pipeline/prompts"])
    await checkTree(path.join(root, input));
  const packages = new Set();
  async function checkPackage(name, from) {
    const { dir, meta } = await packageDirectory(name, from);
    if (packages.has(dir)) return;
    packages.add(dir);
    await checkTree(dir);
    for (const dep of Object.keys(meta.dependencies ?? {})) await checkPackage(dep, dir);
  }
  // A missing server manifest means there can be no successful production build.
  if (await stat(path.join(root, "apps/server/package.json")).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) {
    for (const name of ["better-sqlite3", "linkedom"]) await checkPackage(name, path.join(root, "apps/server"));
  }
  const placeholder = await open(destination, "wx");
  await placeholder.close();
} else {
  try {
    await mkdir(out);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Desktop bundle destination already exists: ${out}. Preserve or move it, then build again.`, { cause: error });
    throw error;
  }
  await mkdir(server);
}
const injectFakes = testOutput
  ? [
      {
        name: "offline-test-providers",
        setup(build) {
          build.onResolve({ filter: /^\.\/providers\/index\.ts$/ }, (args) =>
            args.importer === path.join(root, "apps/server/src/main.ts")
              ? { path: path.join(root, "apps/server/test/desktop-bundle-fakes.ts") }
              : undefined,
          );
        },
      },
    ]
  : [];
await build({
  entryPoints: [path.join(root, "apps/server/src/main.ts")],
  outfile: testOutput ? path.resolve(testOutput) : path.join(server, "server.mjs"),
  plugins: injectFakes,
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  external: ["better-sqlite3", "linkedom"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
if (!testOutput) {
  await cp(path.join(root, "apps/server/src/db/migrations"), path.join(server, "migrations"), {
    recursive: true,
  });
  await cp(path.join(root, "apps/server/src/pipeline/prompts"), path.join(server, "prompts"), {
    recursive: true,
  });
  await cp(path.join(root, "apps/web/dist"), path.join(out, "web"), { recursive: true });
  await writeFile(
    path.join(out, "package.json"),
    await readFile(path.join(root, "apps/server/package.json")),
  );

  // Copy physical package trees and their runtime dependencies, not pnpm's outside links.
  async function copyPackage(name, from, dest) {
    const { dir, meta } = await packageDirectory(name, from);
    const target = path.join(dest, "node_modules", name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(dir, target, { recursive: true, dereference: true });
    for (const dep of Object.keys(meta.dependencies ?? {}))
      await copyPackage(dep, dir, target);
  }
  for (const name of ["better-sqlite3", "linkedom"])
    await copyPackage(name, path.join(root, "apps/server"), server);
  const bundledRequire = createRequire(path.join(server, "server.mjs"));
  const Database = bundledRequire("better-sqlite3");
  const probe = new Database(":memory:");
  probe.prepare("SELECT 1").get();
  probe.close();
  await mkdir(path.join(out, "node"), { recursive: true });
  await cp(process.execPath, path.join(out, "node", path.basename(process.execPath)));
  console.log(`Desktop bundle: ${out}; Node ${process.version}, ABI ${process.versions.modules}`);
} else {
  console.log(`Offline test bundle: ${testOutput}`);
}
