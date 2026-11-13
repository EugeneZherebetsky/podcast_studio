import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { generatePodcastScript } from "./cli/chatgpt-script.ts";

import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";
import type { GenerateOptions } from "./providers/llm/chatgpt-inference.ts";

export function chatGptDeadline(stage: string): number {
  const raw = stage === "script" ? process.env.CHATGPT_SCRIPT_TIMEOUT_MS : process.env.CHATGPT_STAGE_TIMEOUT_MS;
  const value = raw === undefined ? (stage === "script" ? 300_000 : 120_000) : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 900_000) throw new Error("Invalid ChatGPT stage timeout");
  return value;
}

const Selection = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local") }).strict(),
  z.object({ provider: z.literal("chatgpt"), account: z.string().min(1).max(40), model: z.string().min(1).max(200), scope: z.literal("all-stages").optional() }).strict(),
]);
type Session = Pick<Awaited<ReturnType<typeof createChatGptSession>>, "status" | "models" | "generateStructured">;

export class ScriptPreflightError extends Error {}
export class ChatGptOutputError extends Error {}

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
  function readSelection(): z.infer<typeof Selection> {
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
  function snapshot() {
    return locked(() => {
      const selectedRevision = intent();
      if (selectedRevision !== readRevision(committedFile)) throw new Error("Selection incomplete; select a provider again");
      return { selected: readSelection(), selectedRevision };
    });
  }
  return {
    capture() {
      const current = snapshot();
      const allStages = current.selected.provider === "chatgpt" && current.selected.scope === "all-stages";
      return { chatgptProvider: allStages ? this.provider(current) : undefined, scriptGenerator: allStages ? undefined : this.generator(current) };
    },
    get() {
      return locked(() => intent() !== readRevision(committedFile) ? { provider: "incomplete" as const } : readSelection());
    },
    async models() { const account = requireAccount(); const models = await session!.models(); requireAccount(account); return models; },
    async set(raw: unknown) {
      const input = z.discriminatedUnion("provider", [z.object({ provider: z.literal("local") }).strict(), z.object({ provider: z.literal("chatgpt"), model: z.string().min(1).max(200), scope: z.literal("all-stages").optional() }).strict()]).parse(raw);
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
    provider(current = snapshot()) {
      const { selected, selectedRevision } = current;
      if (selected.provider === "local") return undefined;
      if (selected.scope !== "all-stages") throw new ScriptPreflightError("Select ChatGPT for all stages again after reviewing the privacy notice");
      requireAccount(selected.account);
      return {
        identity: `chatgpt:${selected.account}:${selected.model}`,
        description: `ChatGPT: ${selected.model} (subscription usage unavailable; costUsd 0 is a placeholder)`,
        create(signal?: AbortSignal, options?: () => GenerateOptions) {
          return {
            cacheIdentity: `chatgpt:${selected.account}:${selected.model}`,
            diagnostic: { provider: "chatgpt", models: { main: selected.model, fast: selected.model } },
            async generateObject<T>(request: import("./providers/llm/interface.ts").GenerateObjectRequest<T>) {

              for (let attempt = 0; attempt < 2; attempt++) {
                request.assertContinue?.();
                const pending = locked(() => {
                  const current = readSelection();
                  if (intent() !== selectedRevision || current.provider !== "chatgpt" || current.account !== selected.account || current.model !== selected.model)
                    throw new ScriptPreflightError("Selection changed before generation");
                  try { requireAccount(selected.account); signal?.throwIfAborted(); }
                  catch (error) { throw new ScriptPreflightError(error instanceof Error ? error.message : String(error)); }
                  return session!.generateStructured(selected.model, request.system, request.prompt, z.toJSONSchema(request.schema), signal, options?.() ?? { timeoutMs: chatGptDeadline("other") });
                });
                const text = await pending;
                try { requireAccount(selected.account); }
                catch (error) { throw new ScriptPreflightError(error instanceof Error ? error.message : String(error), { cause: error }); }
                try { return { object: request.schema.parse(JSON.parse(text)) }; }
                catch { if (attempt === 1) throw new ChatGptOutputError("ChatGPT returned invalid structured output after two attempts"); }
              }
              throw new Error("Unreachable");
            },
          };
        },
      };
    },
    generator(current = snapshot()) {
      const { selected, selectedRevision } = current;
      if (selected.provider === "local") return undefined;
      requireAccount(selected.account);
      return {
        identity: `chatgpt:${selected.account}:${selected.model}`,
        description: `ChatGPT script: ${selected.model}`,
        diagnostic: { provider: "chatgpt", model: selected.model },
        async run(input: Parameters<typeof generatePodcastScript>[2], signal?: AbortSignal, options?: GenerateOptions) {
          let started = false;
          let inFlight = false;
          let pending: ReturnType<typeof generatePodcastScript>;
          try {
            pending = locked(() => {
              const current = readSelection();
              if (intent() !== selectedRevision || current.provider !== "chatgpt" || current.account !== selected.account || current.model !== selected.model)
                throw new Error("Script selection changed before generation");
              requireAccount(selected.account);
              signal?.throwIfAborted();
              started = true;
              return generatePodcastScript({ async generateStructured(...args) {
                inFlight = true;
                const response = await session!.generateStructured(...args, options ?? { timeoutMs: chatGptDeadline("script") });
                inFlight = false;
                return response;
              } }, selected.model, input, signal);
            });
          } catch (error) {
            if (started) throw error;
            throw new ScriptPreflightError(error instanceof Error ? error.message : String(error), { cause: error });
          }
          try {
            const result = await pending;
            requireAccount(selected.account);
            return result.script;
          } catch (error) {
            if (inFlight) throw error;
            throw new ScriptPreflightError(error instanceof Error ? error.message : String(error), { cause: error });
          }
        },
      };
    },
  };
}
