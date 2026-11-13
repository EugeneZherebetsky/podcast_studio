import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";
import { beginChatGptLogin } from "../src/providers/llm/chatgpt-login.ts";

it("treats an absent optional refresh token as nothing to revoke", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const revoke = vi.fn(async () => true);
    const session = await createChatGptSession(dir, async () => ({
      authorizationUrl: "https://example.test",
      close() {},
      result: Promise.resolve({ kind: "success" as const, subject: "sub", clientId: "client",
        accessToken: "access", idToken: "id", expiresIn: 60, scopes: [], planEnabled: false }),
    }), revoke);
    await (await session.login("work")).complete();
    expect(await session.signout()).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(session.status().remoteUncertain).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports uncertainty on cancellation during exchange and revokes late credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    let release!: (response: Response) => void;
    let started!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: typeof fetch = async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const revoke = vi.fn(async () => true);
    const session = await createChatGptSession(
      dir,
      (options) => beginChatGptLogin({ ...options, transport }),
      revoke,
    );
    const attempt = await session.login("work");
    const completion = expect(attempt.complete()).rejects.toThrow();
    const auth = new URL(attempt.authorizationUrl);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("code", "code");
    callback.searchParams.set("client_id", "issued");
    await fetch(callback);
    await exchangeStarted;
    expect(await session.signout()).toBe(false);
    await completion;
    expect(session.status().remoteUncertain).toBe(true);
    release(Response.json({ access_token: "access", refresh_token: "refresh" }));
    await vi.waitFor(() =>
      expect(revoke).toHaveBeenCalledWith("refresh", "issued", "refresh_token"),
    );
    expect(await session.signout()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains a warning when revocation fails after registration failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const revoke = vi.fn(async () => false);
    const session = await createChatGptSession(
      dir,
      async () => ({
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
      }),
      revoke,
    );
    await expect((await session.login("constructor")).complete()).rejects.toThrow();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(session.status().remoteUncertain).toBe(true);
    expect(await session.signout()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("revokes credentials when registration storage fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const revoke = vi.fn(async () => true);
    const session = await createChatGptSession(
      dir,
      async () => ({
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
      }),
      revoke,
    );
    await expect((await session.login("constructor")).complete()).rejects.toThrow();
    expect(revoke).toHaveBeenCalledWith("refresh", "client");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses expired access while retaining the refresh token for revocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  vi.useFakeTimers();
  try {
    const revoke = vi.fn(async () => true);
    const session = await createChatGptSession(
      dir,
      async () => ({
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
          expiresAt: Date.now() + 10_000,
          scopes: [],
          planEnabled: true,
        }),
      }),
      revoke,
    );
    await (await session.login("work")).complete();
    vi.advanceTimersByTime(9_999);
    expect(session.status().expired).toBe(false);
    vi.advanceTimersByTime(1);
    expect(session.status()).toMatchObject({ expired: true, planEnabled: false });
    await expect(session.models()).rejects.toThrow(/expired/i);
    await expect(session.generate("m", "p")).rejects.toThrow(/expired/i);
    await expect(session.generateStructured("m", "s", "p", {})).rejects.toThrow(/expired/i);
    expect(await session.signout()).toBe(true);
    expect(revoke).toHaveBeenCalledWith("refresh", "client");
  } finally {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});

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
    expect(session.status()).toMatchObject({
      active: "work",
      accounts: ["work"],
      planEnabled: false,
    });
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
    const revoke = vi.fn(async (token: string, client: string) =>
      ["refresh", "access"].includes(token) && client === "client",
    );
    const session = await createChatGptSession(
      dir,
      async () => ({
        authorizationUrl: "https://example.test",
        close() {},
        result: Promise.resolve(result),
      }),
      revoke,
    );
    const stale = await session.login("old");
    expect(await session.signout()).toBe(true);
    expect(revoke).toHaveBeenCalledWith("refresh", "client");
    expect(revoke).toHaveBeenCalledWith("access", "client", "access_token");
    await expect(stale.complete()).rejects.toThrow("cancelled");
    expect(session.status().accounts).toEqual([]);
    await (await session.login("new")).complete();
    expect(await session.signout()).toBe(true);
    expect(session.status().active).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
