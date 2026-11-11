import type { z } from "zod";

type Issue = z.core.$ZodIssue;

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? String(key) : `.${String(key)}`;
  }
  return out;
}

function formatIssue(issue: Issue): string {
  const path = formatPath(issue.path);
  const prefix = path === "" ? "" : `${path}: `;
  // A failed union only says "Invalid input"; spell out why each alternative was rejected.
  if (issue.code === "invalid_union" && issue.errors.length > 0) {
    const options = issue.errors
      .map((issues, i) => `option ${i + 1}: ${issues.map(formatIssue).join("; ")}`)
      .join(" | ");
    return `${prefix}Invalid input: none of the ${issue.errors.length} allowed shapes matched (${options})`;
  }
  return `${prefix}${issue.message}`;
}

/**
 * Turns a zod error into a readable message: one line per issue, each prefixed with the
 * path of the offending field (`segments[1].text: Invalid input: expected string, …`).
 */
export function formatZodError(error: { issues: readonly Issue[] }): string {
  return error.issues.map(formatIssue).join("\n");
}
