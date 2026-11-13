import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { generatePodcastScript } from "./cli/chatgpt-script.ts";
import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";

const Selection = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local") }).strict(),
  z.object({ provider: z.literal("chatgpt"), account: z.string().min(1).max(40), model: z.string().min(1).max(200) }).strict(),
]);
type Session = Pick<Awaited<ReturnType<typeof createChatGptSession>>, "status" | "models" | "generateStructured">;

export class ScriptPreflightError extends Error {}

export function createScriptSelection(directory: string, session?: Session) {
  const file = path.join(directory, "script-selection.json");
  const intentFile = path.join(directory, "script-selection-intent");
  const committedFile = path.join(directory, "script-selection-committed");
  function locked<T>(fn: () => T): T {
    mkdirSync(directory, { recursive: true });
    const lock = new Database(path.join(directory, "script-selection-lock.sqlite"), { timeout: 5000 });
    try {
      lock.exec("BEGIN IMMEDIATE");
      return fn();
    } finally { lock.close(); }
  }
  function readRevision(file: string) {
    try { return readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
  function intent() { return readRevision(intentFile); }
  function writeAtomic(target: string, value: string) {
    const temp = path.join(directory, `.script-selection-${randomUUID()}.tmp`);
    try { writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); renameSync(temp, target); }
    finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
  }
  function get(): z.infer<typeof Selection> {
    try { return Selection.parse(JSON.parse(readFileSync(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { provider: "local" };
      throw new Error("Invalid script selection; select a provider again", { cause: error });
    }
  }
  function requireAccount(account?: string) {
    if (!session) throw new Error("ChatGPT is unavailable on this host; select a provider from a numeric loopback host");
    const status = session.status();
    if (!status.active || status.expired || !status.planEnabled || (account && status.active !== account))
      throw new Error("Sign in to the selected ChatGPT account with plan access before generating");
    return status.active;
  }
  return {
    get,
    async models() { const account = requireAccount(); const models = await session!.models(); requireAccount(account); return models; },
    async set(raw: unknown) {
      const input = z.discriminatedUnion("provider", [z.object({ provider: z.literal("local") }).strict(), z.object({ provider: z.literal("chatgpt"), model: z.string().min(1).max(200) }).strict()]).parse(raw);
      const choiceRevision = randomUUID();
      locked(() => writeAtomic(intentFile, choiceRevision));
      let value: z.infer<typeof Selection> = { provider: "local" };
      if (input.provider === "chatgpt") {
        const account = requireAccount();
        const models = await session!.models();
        requireAccount(account);
        if (!models.some((item) => item.slug === input.model)) throw new Error("Select an available ChatGPT model");
        value = { ...input, account };
      }
      locked(() => {
        if (choiceRevision !== intent()) throw new Error("Script selection superseded by a newer choice");
        writeAtomic(file, JSON.stringify(value));
        writeAtomic(committedFile, choiceRevision);
      });
      return value;
    },
    generator() {
      const { selected, selectedRevision } = locked(() => {
        const selectedRevision = intent();
        if (selectedRevision !== readRevision(committedFile)) throw new Error("Script selection incomplete; select a provider again");
        return { selected: get(), selectedRevision };
      });
      if (selected.provider === "local") return undefined;
      requireAccount(selected.account);
      return {
        identity: `chatgpt:${selected.account}:${selected.model}`,
        description: `ChatGPT script: ${selected.model}`,
        async run(input: Parameters<typeof generatePodcastScript>[2], signal?: AbortSignal) {
          let started = false;
          let pending: ReturnType<typeof generatePodcastScript>;
          try {
            pending = locked(() => {
              const current = get();
              if (intent() !== selectedRevision || current.provider !== "chatgpt" || current.account !== selected.account || current.model !== selected.model)
                throw new Error("Script selection changed before generation");
              requireAccount(selected.account);
              signal?.throwIfAborted();
              started = true;
              return generatePodcastScript(session!, selected.model, input, signal);
            });
          } catch (error) {
            if (started) throw error;
            throw new ScriptPreflightError(error instanceof Error ? error.message : String(error), { cause: error });
          }
          const result = await pending;
          requireAccount(selected.account);
          return result.script;
        },
      };
    },
  };
}
