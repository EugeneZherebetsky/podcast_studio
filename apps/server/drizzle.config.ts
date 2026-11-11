import { defineConfig } from "drizzle-kit";

// Used only by `pnpm --filter server db:generate` to write SQL migrations from the schema.
// The server applies them itself at startup (src/db/index.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
