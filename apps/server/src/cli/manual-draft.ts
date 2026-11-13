import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { ensureDataDirs } from "../data-dir.ts";
import { openDatabase } from "../db/index.ts";
import { manualImport, manualPrepare } from "../pipeline/manual-workflow.ts";

async function main(): Promise<void> {
  const [action, id, prepared, response, ...extra] = process.argv.slice(2);
  if (
    !id ||
    extra.length ||
    (action === "prepare" ? prepared !== undefined : action !== "import" || !prepared || !response)
  )
    throw new Error(
      "Usage: pnpm --filter server manual-draft prepare JOB_ID | pnpm --filter server manual-draft import JOB_ID PREPARATION_DIR RESPONSE_JSON",
    );
  const config = loadConfig();
  const dirs = ensureDataDirs(config.DATA_DIR);
  const db = openDatabase(dirs.dbFile);
  try {
    if (action === "prepare") {
      const dir = await manualPrepare(db, dirs.root, id);
      console.log(`Review the sharing warning before using ${dir}/prompt.txt`);
      console.log(`Preparation directory: ${dir}`);
    } else {
      const file = await manualImport(
        db,
        dirs.root,
        id,
        prepared!,
        await readFile(response!, "utf8"),
      );
      console.log(`Validated draft: ${file}`);
      console.log("Draft is isolated and not connected to review, audio, or publication.");
    }
  } finally {
    db.$client.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
