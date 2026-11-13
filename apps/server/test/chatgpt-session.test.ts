import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";

it("keeps tokens in memory and reuses the selected account after signout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const calls: unknown[] = [];
    const login = async (options: {
      hostId: string;
      clientId?: string;
      expectedSubject?: string;
    }) => {
      calls.push(options);
      return {
        authorizationUrl: "https://example.test",
        close() {},
        result: Promise.resolve({
          kind: "success" as const,
          subject: "sub",
          clientId: "client",
          accessToken: "access",
          refreshToken: "refresh",
          idToken: "id",
          expiresIn: 60,
          scopes: [],
          planEnabled: false,
        }),
      };
    };
    const session = await createChatGptSession(dir, login, async () => false);
    const attempt = await session.login("work");
    await attempt.complete();
    await expect(session.models()).rejects.toThrow("plan-enabled");
    await expect(session.generate("m", "prompt")).rejects.toThrow("plan-enabled");
    expect(session.status()).toEqual({ active: "work", accounts: ["work"], planEnabled: false });
    expect(await session.signout()).toBe(false);
    expect(session.status().active).toBe(null);
    const returning = await session.login("work");
    await returning.complete();
    expect(calls[1]).toMatchObject({ clientId: "client", expectedSubject: "sub" });
    expect((calls[0] as { hostId: string }).hostId).toBe((calls[1] as { hostId: string }).hostId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
