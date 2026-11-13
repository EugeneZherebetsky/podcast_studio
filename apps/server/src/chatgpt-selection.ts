import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { generatePodcastScript } from "./cli/chatgpt-script.ts";
import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";

const Selection = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local") }).strict(),
  z.object({ provider: z.literal("chatgpt"), account: z.string().min(1).max(40), model: z.string().min(1).max(200) }).strict(),
]);
type Session = Pick<Awaited<ReturnType<typeof createChatGptSession>>, "status" | "models" | "generateStructured">;

export function createScriptSelection(directory: string, session: Session) {
  const file = path.join(directory, "script-selection.json");
  function get(): z.infer<typeof Selection> {
    try { return Selection.parse(JSON.parse(readFileSync(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { provider: "local" };
      throw new Error("Invalid script selection; select a provider again", { cause: error });
    }
  }
  function requireAccount(account?: string) {
    const status = session.status();
    if (!status.active || status.expired || !status.planEnabled || (account && status.active !== account))
      throw new Error("Sign in to the selected ChatGPT account with plan access before generating");
    return status.active;
  }
  return {
    get,
    async models() { const account = requireAccount(); const models = await session.models(); requireAccount(account); return models; },
    async set(raw: unknown) {
      const input = z.discriminatedUnion("provider", [z.object({ provider: z.literal("local") }).strict(), z.object({ provider: z.literal("chatgpt"), model: z.string().min(1).max(200) }).strict()]).parse(raw);
      let value: z.infer<typeof Selection> = { provider: "local" };
      if (input.provider === "chatgpt") {
        const account = requireAccount();
        const models = await session.models();
        requireAccount(account);
        if (!models.some((item) => item.slug === input.model)) throw new Error("Select an available ChatGPT model");
        value = { ...input, account };
      }
      mkdirSync(directory, { recursive: true });
      const temp = path.join(directory, `.script-selection-${randomUUID()}.tmp`);
      try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
      finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
      return value;
    },
    generator() {
      const selected = get();
      if (selected.provider === "local") return undefined;
      requireAccount(selected.account);
      return {
        identity: `chatgpt:${selected.account}:${selected.model}`,
        async run(input: Parameters<typeof generatePodcastScript>[2]) {
          requireAccount(selected.account);
          const result = await generatePodcastScript(session, selected.model, input);
          requireAccount(selected.account);
          return result.script;
        },
      };
    },
  };
}
