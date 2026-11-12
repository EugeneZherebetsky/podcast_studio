import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function manageAutostart(
  action,
  { run = spawnSync, platform = process.platform, root = rootDir, node = process.execPath } = {},
) {
  if (platform !== "win32") throw new Error("Autostart is only supported on Windows");
  if (!["install", "remove"].includes(action)) throw new Error("Expected install or remove");
  const task = `PodcastStudio-${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16)}`;
  const launcher = path.win32.join(root, "scripts", "autostart-server.mjs");
  const call = (args) => {
    const result = run("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0)
      throw new Error(
        `Task Scheduler failed: ${result.error?.message ?? result.stderr ?? result.status}`,
      );
    return result.stdout;
  };
  if (action === "install") {
    call(["/CREATE", "/TN", task, "/SC", "ONLOGON", "/IT", "/TR", `"${node}" "${launcher}"`]);
  } else {
    const xml = call(["/QUERY", "/TN", task, "/XML"]);
    const decode = (s) =>
      s
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    const field = (name) => decode(xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "");
    const actions = xml.match(/<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/)?.[1] ?? "";
    if (
      !/^\s*<Exec>\s*<Command>[^<]*<\/Command>\s*<Arguments>[^<]*<\/Arguments>\s*<\/Exec>\s*$/.test(actions) ||
      field("Command").replace(/^"|"$/g, "").toLowerCase() !== node.toLowerCase() ||
      field("Arguments") !== `"${launcher}"`
    ) {
      throw new Error("Task action does not match this installation; refusing to remove it");
    }
    call(["/DELETE", "/TN", task, "/F"]);
  }
  return task;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`${process.argv[2]}: ${manageAutostart(process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
