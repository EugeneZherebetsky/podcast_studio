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

it("cancels a pending login on signout and allows a new attempt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const session = await createChatGptSession(dir);
    const attempt = await session.login("work");
    const callback = new URL(new URL(attempt.authorizationUrl).searchParams.get("redirect_uri")!);
    const completion = expect(attempt.complete()).rejects.toThrow();
    await expect(session.login("other")).rejects.toThrow("pending");
    expect(await session.signout()).toBe(true);
    await completion;
    await expect(fetch(callback)).rejects.toThrow();
    const next = await session.login("other");
    const nextCompletion = expect(next.complete()).rejects.toThrow();
    await session.shutdown();
    await nextCompletion;
    expect(session.status().active).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("cancels a login that is still starting and never activates its late result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false;
    const start = async () => {
      await gate;
      return {
        authorizationUrl: "https://example.test",
        close() {
          closed = true;
        },
        result: Promise.resolve({
          kind: "success" as const,
          subject: "sub",
          clientId: "client",
          accessToken: "access",
          idToken: "id",
          expiresIn: 60,
          scopes: [],
          planEnabled: false,
        }),
      };
    };
    const session = await createChatGptSession(dir, start);
    const login = session.login("work");
    const failed = expect(login).rejects.toThrow("cancelled");
    const stopping = session.shutdown();
    release();
    await stopping;
    await failed;
    expect(closed).toBe(true);
    expect(session.status().active).toBe(null);
    await expect(session.login("other")).rejects.toThrow("closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("cannot complete a cancelled attempt and reports successful revocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const result = {
      kind: "success" as const,
      subject: "sub",
      clientId: "client",
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
      expiresIn: 60,
      scopes: [],
      planEnabled: false,
    };
    const session = await createChatGptSession(
      dir,
      async () => ({
        authorizationUrl: "https://example.test",
        close() {},
        result: Promise.resolve(result),
      }),
      async (token, client) => token === "refresh" && client === "client",
    );
    const stale = await session.login("old");
    await session.signout();
    await expect(stale.complete()).rejects.toThrow("cancelled");
    expect(session.status().accounts).toEqual([]);
    await (await session.login("new")).complete();
    expect(await session.signout()).toBe(true);
    expect(session.status().active).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
