import { build } from "esbuild";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-desktop");
const server = path.join(out, "server");
await mkdir(server, { recursive: true });
if (process.versions.node.split(".")[0] !== "22")
  throw new Error("Build with the project's Node 22 runtime");
const testOutput =
  process.argv[2] === "--test-output" && process.argv[3]
    ? path.resolve(process.argv[3])
    : undefined;
if (process.argv.length > 2 && (!testOutput || process.argv.length !== 4))
  throw new Error("Usage: node scripts/build-desktop.mjs [--test-output <isolated-file>]");
if (testOutput && !path.relative(out, testOutput).startsWith(".."))
  throw new Error("Test bundles must be outside dist-desktop");
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
    const requireFrom = createRequire(path.join(from, "package.json"));
    const entry = await realpath(requireFrom.resolve(name));
    let dir = path.dirname(entry);
    for (;;) {
      try {
        const meta = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
        if (meta.name === name) {
          const target = path.join(dest, "node_modules", name);
          await mkdir(path.dirname(target), { recursive: true });
          await cp(dir, target, { recursive: true, dereference: true });
          for (const dep of Object.keys(meta.dependencies ?? {}))
            await copyPackage(dep, dir, target);
          return;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`Cannot locate package ${name}`);
      dir = parent;
    }
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
