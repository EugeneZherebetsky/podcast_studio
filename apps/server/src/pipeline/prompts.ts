// Prompt templates (ARCHITECTURE §3 "Prompt handling"): markdown files in ./prompts with
// {{placeholders}}, one per stage or step. Each file has a "# System" and a "# User" part.
import { readFileSync } from "node:fs";

export const PROMPT_NAMES = [
  "plan",
  "notes-map",
  "notes-merge",
  "script",
  "review",
  "graded-annotation",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export interface PromptTemplate {
  system: string;
  user: string;
}

/** The two strings of one LLM call. */
export interface RenderedPrompt {
  system: string;
  prompt: string;
}

const SYSTEM_HEADING = "# System";
const USER_HEADING = "# User";
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function parsePromptTemplate(markdown: string, name = "prompt"): PromptTemplate {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const systemAt = lines.findIndex((line) => line.trim() === SYSTEM_HEADING);
  const userAt = lines.findIndex((line) => line.trim() === USER_HEADING);
  if (systemAt === -1) {
    throw new Error(`Prompt template "${name}" has no "${SYSTEM_HEADING}" heading`);
  }
  if (userAt === -1) throw new Error(`Prompt template "${name}" has no "${USER_HEADING}" heading`);
  if (userAt < systemAt) {
    throw new Error(
      `Prompt template "${name}": "${SYSTEM_HEADING}" must come before "${USER_HEADING}"`,
    );
  }
  const system = lines
    .slice(systemAt + 1, userAt)
    .join("\n")
    .trim();
  const user = lines
    .slice(userAt + 1)
    .join("\n")
    .trim();
  if (system === "" || user === "") {
    throw new Error(`Prompt template "${name}" has an empty system or user part`);
  }
  return { system, user };
}

const cache = new Map<PromptName, PromptTemplate>();

/** Reads `./prompts/<name>.md`. Templates are small and fixed, so they are read once. */
export function loadPrompt(name: PromptName): PromptTemplate {
  let template = cache.get(name);
  if (!template) {
    const file = new URL(`./prompts/${name}.md`, import.meta.url);
    template = parsePromptTemplate(readFileSync(file, "utf8"), name);
    cache.set(name, template);
  }
  return template;
}

function placeholdersOf(template: string): Set<string> {
  return new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]!));
}

function fill(template: string, values: Readonly<Record<string, string>>, name: string): string {
  // One pass: text that looks like a placeholder inside a value is left alone.
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Prompt template "${name}": no value for placeholder {{${key}}}`);
    }
    return values[key]!;
  });
}

function assertAllUsed(
  parts: readonly string[],
  values: Readonly<Record<string, string>>,
  name: string,
): void {
  const used = new Set(parts.flatMap((part) => [...placeholdersOf(part)]));
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length > 0) {
    // A template that lost {{sourceText}} would silently ask the model about nothing.
    throw new Error(
      `Prompt template "${name}" has no placeholder for: ${unused.map((key) => `{{${key}}}`).join(", ")}`,
    );
  }
}

/** Fills a single string. Every placeholder needs a value and every value a placeholder. */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  name = "prompt",
): string {
  assertAllUsed([template], values, name);
  return fill(template, values, name);
}

/** Fills both parts of a template; a value may be used by either part. */
export function renderPrompt(
  template: PromptTemplate,
  values: Readonly<Record<string, string>>,
  name = "prompt",
): RenderedPrompt {
  assertAllUsed([template.system, template.user], values, name);
  return {
    system: fill(template.system, values, name),
    prompt: fill(template.user, values, name),
  };
}

/**
 * Makes untrusted text safe to put between `<source id="…">` and `</source>`: any source
 * tag inside it is defused, so the text cannot end its wrapper or open another one.
 */
export function escapeSourceText(text: string): string {
  return text.replace(/<(?=\s*\/?\s*source)/gi, "&lt;");
}
