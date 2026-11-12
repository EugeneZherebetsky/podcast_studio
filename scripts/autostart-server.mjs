import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = path.join(root, "apps/web");
const build = spawnSync(
  process.execPath,
  [path.join(web, "node_modules/vite/bin/vite.js"), "build"],
  {
    cwd: web,
    stdio: "inherit",
  },
);
if (build.error || build.status !== 0) {
  console.error(`Web build failed: ${build.error?.message ?? build.status}`);
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [
    path.join(root, "apps/server/node_modules/tsx/dist/cli.mjs"),
    path.join(root, "apps/server/src/main.ts"),
  ],
  { cwd: root, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
