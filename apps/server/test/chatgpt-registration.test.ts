import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openRegistrationStore } from "../src/providers/llm/chatgpt-registration.ts";

describe("ChatGPT registrations", () => {
  it("persists a stable host and separate verified account mappings without tokens", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-registration-"));
    try {
      const first = await openRegistrationStore(dir);
      await first.save("first", "client-1", "subject-1");
      await first.save("second", "client-2", "subject-1");
      const second = await openRegistrationStore(dir);
      expect(second.hostId).toBe(first.hostId);
      expect(second.accounts).toEqual({
        first: { clientId: "client-1", subject: "subject-1" },
        second: { clientId: "client-2", subject: "subject-1" },
      });
      const disk = await readFile(path.join(dir, "chatgpt-registration.json"), "utf8");
      expect(disk).not.toMatch(/accessToken|refreshToken|idToken/);
      await expect(second.save("first", "other", "subject-2")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
