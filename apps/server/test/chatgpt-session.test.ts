import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, expect, it, vi } from "vitest";
import {
  createChatGptSession,
  revokeToken,
  type RevokeOutcome,
} from "../src/providers/llm/chatgpt-session.ts";
import { beginChatGptLogin } from "../src/providers/llm/chatgpt-login.ts";

it("treats an absent optional refresh token as nothing to revoke", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
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
          idToken: "id",
          expiresIn: 60,
          scopes: [],
          planEnabled: false,
        }),
      }),
      revoke,
    );
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
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
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
    const observer = await createChatGptSession(dir);
    await observer.acknowledgeRemoteDisconnect();
    expect(observer.status().remoteUncertain).toBe(true);
    release(Response.json({ access_token: "access", refresh_token: "refresh" }));
    await vi.waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(
        "refresh",
        "issued",
        "refresh_token",
        expect.any(AbortSignal),
      ),
    );
    // The late refresh token was revoked with confirmation, so its record is removed.
    await vi.waitFor(() => expect(session.status().remoteUncertain).toBe(false));
    expect(await session.signout()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains a warning when revocation fails after registration failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  try {
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "refused");
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
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
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
    expect(revoke).toHaveBeenCalledWith(
      "refresh",
      "client",
      "refresh_token",
      expect.any(AbortSignal),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses expired access while retaining the refresh token for revocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-session-"));
  vi.useFakeTimers();
  try {
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
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
    expect(revoke).toHaveBeenCalledWith(
      "refresh",
      "client",
      "refresh_token",
      expect.any(AbortSignal),
    );
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
    const session = await createChatGptSession(
      dir,
      login,
      async (): Promise<RevokeOutcome> => "refused",
    );
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
    await session.shutdown();
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
    expect(await records(dir)).toEqual([]);
    expect(session.status().remoteUncertain).toBe(false);
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
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
    const session = await createChatGptSession(dir, start, revoke);
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
    const revoke = vi.fn(async (token: string, client: string): Promise<RevokeOutcome> =>
      ["refresh", "access"].includes(token) && client === "client" ? "revoked" : "refused",
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
    expect(revoke).toHaveBeenCalledWith(
      "refresh",
      "client",
      "refresh_token",
      expect.any(AbortSignal),
    );
    expect(revoke).toHaveBeenCalledWith(
      "access",
      "client",
      "access_token",
      expect.any(AbortSignal),
    );
    await expect(stale.complete()).rejects.toThrow("cancelled");
    expect(session.status().accounts).toEqual([]);
    await (await session.login("new")).complete();
    expect(await session.signout()).toBe(true);
    expect(session.status().active).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Durable record of possibly outstanding grants ----

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let keys: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test";
  keys = createLocalJWKSet({ keys: [jwk] });
});

type Records = {
  id: string;
  label: string;
  clientId: string;
  state: string;
  accessExpiresAt?: number;
}[];
async function records(dir: string): Promise<Records> {
  try {
    return (
      JSON.parse(await readFile(path.join(dir, "chatgpt-grants.json"), "utf8")) as {
        grants: Records;
      }
    ).grants;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function onDisk(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return (
    await Promise.all(files.map((file) => readFile(path.join(file.parentPath, file.name), "utf8")))
  ).join("\n");
}
function approve(authorizationUrl: string, code = "code") {
  const auth = new URL(authorizationUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  callback.searchParams.set("code", code);
  callback.searchParams.set("client_id", "issued");
  return fetch(callback);
}
async function tokens(authorizationUrl: string, extra: Record<string, unknown> = {}) {
  const nonce = new URL(authorizationUrl).searchParams.get("nonce")!;
  const idToken = await new SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://auth.openai.com")
    .setAudience("issued")
    .setSubject("user")
    .setExpirationTime("5m")
    .sign(privateKey);
  return Response.json({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid offline_access chatgpt.tokens.use.direct resource.invoke",
    ...extra,
  });
}
function fakeLogin(overrides: Record<string, unknown> = {}) {
  return async () => ({
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
      ...overrides,
    }),
  });
}
async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-grants-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
type Revoke = (
  token: string,
  clientId: string,
  hint: string,
  signal: AbortSignal,
) => Promise<RevokeOutcome>;
const fast = { retryDelaysMs: [1, 1, 1], signoutBudgetMs: 2_000, shutdownBudgetMs: 300 };

it("records nothing when sign-in is cancelled before the token request", () =>
  withDir(async (dir) => {
    const transport = vi.fn<typeof fetch>();
    const session = await createChatGptSession(dir, (options) =>
      beginChatGptLogin({ ...options, transport, keys }),
    );
    const attempt = await session.login("work");
    const completion = expect(attempt.complete()).rejects.toThrow();
    expect(await session.signout()).toBe(true);
    await completion;
    expect(transport).not.toHaveBeenCalled();
    expect(await records(dir)).toEqual([]);
    expect(session.status().remoteUncertain).toBe(false);
    const next = await session.login("work");
    const nextCompletion = expect(next.complete()).rejects.toThrow();
    await session.shutdown();
    await nextCompletion;
  }));

it("writes a record only once the exchange starts, visible to a fresh session", () =>
  withDir(async (dir) => {
    let started!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: typeof fetch = async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    };
    const session = await createChatGptSession(dir, (options) =>
      beginChatGptLogin({ ...options, transport, keys }),
    );
    const attempt = await session.login("work");
    const completion = expect(attempt.complete()).rejects.toThrow();
    expect(await records(dir)).toEqual([]);
    await approve(attempt.authorizationUrl);
    await exchangeStarted;
    expect(await records(dir)).toMatchObject([
      { label: "work", clientId: "issued", state: "grant-may-exist" },
    ]);
    expect(session.status().remoteUncertain).toBe(false);
    const other = await createChatGptSession(dir);
    expect(other.status()).toMatchObject({
      remoteUncertain: true,
      uncertain: [{ label: "work", cause: "stopped-while-signed-in" }],
    });
    expect(await session.signout()).toBe(false);
    await completion;
    await vi.waitFor(async () =>
      expect(await records(dir)).toMatchObject([{ state: "revocation-unconfirmed" }]),
    );
  }));

it("does not send the authorization code when the record cannot be written", () =>
  withDir(async (dir) => {
    const transport = vi.fn<typeof fetch>();
    const session = await createChatGptSession(dir, (options) =>
      beginChatGptLogin({ ...options, transport, keys }),
    );
    const attempt = await session.login("work");
    const completion = expect(attempt.complete()).rejects.toThrow();
    // Another writer holds the lock for longer than the store waits.
    await mkdir(path.join(dir, "chatgpt-registration.lock"));
    await approve(attempt.authorizationUrl);
    await completion;
    expect(transport).not.toHaveBeenCalled();
    await rm(path.join(dir, "chatgpt-registration.lock"), { recursive: true });
    expect(await records(dir)).toEqual([]);
    expect(session.status().remoteUncertain).toBe(false);
  }));

it("removes the record on a token error response and keeps it on transport failure", () =>
  withDir(async (dir) => {
    let seenDuringRequest: Records = [];
    const refused: typeof fetch = async () => {
      seenDuringRequest = await records(dir);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const first = await createChatGptSession(dir, (options) =>
      beginChatGptLogin({ ...options, transport: refused, keys }),
    );
    const attempt = await first.login("work");
    const completion = expect(attempt.complete()).rejects.toThrow();
    await approve(attempt.authorizationUrl);
    await completion;
    expect(seenDuringRequest).toMatchObject([{ state: "grant-may-exist" }]);
    expect(await records(dir)).toEqual([]);
    expect(first.status().remoteUncertain).toBe(false);

    const broken: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    const second = await createChatGptSession(dir, (options) =>
      beginChatGptLogin({ ...options, transport: broken, keys }),
    );
    const retry = await second.login("work");
    const failed = expect(retry.complete()).rejects.toThrow();
    await approve(retry.authorizationUrl);
    await failed;
    expect(await records(dir)).toMatchObject([
      { label: "work", clientId: "issued", state: "revocation-unconfirmed" },
    ]);
    expect(second.status()).toMatchObject({
      remoteUncertain: true,
      uncertain: [{ label: "work", cause: "signout-not-confirmed" }],
    });
  }));

it("does not warn about the live session, warns another session, and clears on confirmed sign-out", () =>
  withDir(async (dir) => {
    let url = "";
    const transport: typeof fetch = async () => tokens(url);
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
    const session = await createChatGptSession(
      dir,
      (options) => beginChatGptLogin({ ...options, transport, keys }),
      revoke,
    );
    const attempt = await session.login("work");
    url = attempt.authorizationUrl;
    const completion = attempt.complete();
    await approve(url);
    expect(await completion).toBe(true);
    expect(session.status()).toMatchObject({
      active: "work",
      remoteUncertain: false,
      uncertain: [],
    });
    expect(await records(dir)).toMatchObject([{ state: "grant-may-exist" }]);
    const other = await createChatGptSession(dir);
    expect(other.status()).toMatchObject({
      remoteUncertain: true,
      uncertain: [{ label: "work", cause: "stopped-while-signed-in" }],
    });
    expect(await session.signout()).toBe(true);
    expect(revoke).toHaveBeenCalledWith(
      "refresh-secret",
      "issued",
      "refresh_token",
      expect.any(AbortSignal),
    );
    expect(await records(dir)).toEqual([]);
    expect(other.status().remoteUncertain).toBe(false);
  }));

it("treats an empty 200 as revoked, including for an already-invalid token", async () => {
  const calls: { url: string; body: string }[] = [];
  const respond = (revocation: () => Response) =>
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/.well-known/openid-configuration"))
        return Response.json({ revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
      return revocation();
    });
  try {
    vi.stubGlobal(
      "fetch",
      respond(() => new Response(null, { status: 200 })),
    );
    expect(await revokeToken("already-invalid", "issued")).toBe("revoked");
    const body = new URLSearchParams(calls.at(-1)!.body);
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("issued");
    vi.stubGlobal(
      "fetch",
      respond(() => new Response(null, { status: 503 })),
    );
    expect(await revokeToken("t", "issued")).toBe("retryable");
    vi.stubGlobal(
      "fetch",
      respond(() => new Response(null, { status: 400 })),
    );
    expect(await revokeToken("t", "issued")).toBe("refused");
    vi.stubGlobal(
      "fetch",
      respond(() => {
        throw new TypeError("network down");
      }),
    );
    expect(await revokeToken("t", "issued")).toBe("retryable");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ revocation_endpoint: "https://evil.test/revoke" }),
      ),
    );
    expect(await revokeToken("t", "issued")).toBe("refused");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retries network failures within the budget and keeps an unconfirmed record otherwise", () =>
  withDir(async (dir) => {
    const outcomes: RevokeOutcome[] = ["retryable", "revoked"];
    const flaky = vi.fn<Revoke>(async (token) =>
      token === "refresh" ? (outcomes.shift() ?? "revoked") : "revoked",
    );
    const session = await createChatGptSession(dir, fakeLogin(), flaky, fast);
    await (await session.login("work")).complete();
    expect(await session.signout()).toBe(true);
    expect(flaky.mock.calls.filter(([token]) => token === "refresh")).toHaveLength(2);
    expect(await records(dir)).toEqual([]);

    const down = vi.fn<Revoke>(async () => "retryable");
    const failing = await createChatGptSession(dir, fakeLogin({ planEnabled: true }), down, fast);
    await (await failing.login("work")).complete();
    expect(await failing.signout()).toBe(false);
    expect(down.mock.calls.filter(([token]) => token === "refresh")).toHaveLength(4);
    expect(await records(dir)).toMatchObject([{ label: "work", state: "revocation-unconfirmed" }]);
    expect(failing.status()).toMatchObject({ active: null, remoteUncertain: true });
    await expect(failing.models()).rejects.toThrow("plan-enabled");
  }));

it("does not retry or confirm a refused (4xx) revocation", () =>
  withDir(async (dir) => {
    const refused = vi.fn<Revoke>(async () => "refused");
    const session = await createChatGptSession(dir, fakeLogin(), refused, fast);
    await (await session.login("work")).complete();
    expect(await session.signout()).toBe(false);
    expect(refused.mock.calls.filter(([token]) => token === "refresh")).toHaveLength(1);
    expect(await records(dir)).toMatchObject([{ state: "revocation-unconfirmed" }]);
  }));

it("bounds an unconfirmed access-only grant by the access-token expiry", () =>
  withDir(async (dir) => {
    const expiresAt = Date.now() + 1_500;
    const down = vi.fn(async (): Promise<RevokeOutcome> => "retryable");
    const session = await createChatGptSession(
      dir,
      fakeLogin({ refreshToken: undefined, expiresAt }),
      down,
      fast,
    );
    await (await session.login("work")).complete();
    expect(await session.signout()).toBe(false);
    expect(down).toHaveBeenCalledTimes(4);
    expect(await records(dir)).toMatchObject([
      { state: "revocation-unconfirmed", accessExpiresAt: expiresAt },
    ]);
    expect(session.status().remoteUncertain).toBe(true);
    await vi.waitFor(() => expect(session.status().remoteUncertain).toBe(false), {
      timeout: 3_000,
      interval: 50,
    });
    expect((await createChatGptSession(dir)).status().remoteUncertain).toBe(false);
  }));

it("refuses acknowledgement while busy and otherwise clears the warning durably", () =>
  withDir(async (dir) => {
    let gate: Promise<void> | undefined;
    const revoke = vi.fn<Revoke>(async () => {
      if (gate) await gate;
      return "refused";
    });
    let mode: "success" | "wait" = "success";
    const start = async () => {
      if (mode === "success") return fakeLogin()();
      let reject!: (error: Error) => void;
      return {
        authorizationUrl: "https://example.test",
        close: () => reject(new Error("closed")),
        result: new Promise<never>((_resolve, fail) => {
          reject = fail;
        }),
      };
    };
    const session = await createChatGptSession(dir, start, revoke, fast);
    await (await session.login("work")).complete();
    await expect(session.acknowledgeRemoteDisconnect()).rejects.toThrow();
    expect(await session.signout()).toBe(false);
    expect(session.status().remoteUncertain).toBe(true);

    mode = "wait";
    const waiting = await session.login("work");
    const waitingDone = expect(waiting.complete()).rejects.toThrow();
    await expect(session.acknowledgeRemoteDisconnect()).rejects.toThrow();
    await session.signout();
    await waitingDone;

    mode = "success";
    await (await session.login("work")).complete();
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const before = revoke.mock.calls.length;
    const signingOut = session.signout();
    await vi.waitFor(() => expect(revoke.mock.calls.length).toBeGreaterThan(before));
    await expect(session.acknowledgeRemoteDisconnect()).rejects.toThrow();
    open();
    expect(await signingOut).toBe(false);
    gate = undefined;

    await session.acknowledgeRemoteDisconnect();
    expect(session.status()).toMatchObject({ remoteUncertain: false, uncertain: [] });
    expect(await records(dir)).toEqual([]);
    expect((await createChatGptSession(dir)).status().remoteUncertain).toBe(false);
  }));

it("keeps an older unconfirmed record through a new successful sign-in", () =>
  withDir(async (dir) => {
    let outcome: RevokeOutcome = "refused";
    const revoke = vi.fn(async (): Promise<RevokeOutcome> => outcome);
    const session = await createChatGptSession(dir, fakeLogin(), revoke, fast);
    await (await session.login("old")).complete();
    expect(await session.signout()).toBe(false);
    outcome = "revoked";
    await (await session.login("old")).complete();
    expect(session.status()).toMatchObject({
      active: "old",
      remoteUncertain: true,
      uncertain: [{ label: "old", cause: "signout-not-confirmed" }],
    });
    expect(await records(dir)).toHaveLength(2);
    await session.signout();
    expect(await records(dir)).toMatchObject([{ label: "old", state: "revocation-unconfirmed" }]);
    expect(session.status().remoteUncertain).toBe(true);
  }));

it("attempts revocation once on shutdown within its bound and records the outcome", () =>
  withDir(async (dir) => {
    const hanging = vi.fn<Revoke>(() => new Promise<RevokeOutcome>(() => {}));
    const stuck = await createChatGptSession(dir, fakeLogin(), hanging, fast);
    await (await stuck.login("work")).complete();
    const began = Date.now();
    await stuck.shutdown();
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(hanging).toHaveBeenCalledTimes(2);
    expect(await records(dir)).toMatchObject([{ state: "revocation-unconfirmed" }]);
    expect(stuck.status().active).toBe(null);

    const flaky = vi.fn<Revoke>(async () => "retryable");
    const once = await createChatGptSession(dir, fakeLogin(), flaky, fast);
    await (await once.login("again")).complete();
    await once.shutdown();
    expect(flaky.mock.calls.filter(([token]) => token === "refresh")).toHaveLength(1);
    expect(await records(dir)).toHaveLength(2);

    const ok = vi.fn(async (): Promise<RevokeOutcome> => "revoked");
    const clean = await createChatGptSession(dir, fakeLogin(), ok, fast);
    await clean.acknowledgeRemoteDisconnect();
    await (await clean.login("work")).complete();
    expect(await records(dir)).toHaveLength(1);
    await clean.shutdown();
    expect(await records(dir)).toEqual([]);
  }));

it("never writes tokens, codes, verifiers or the authorization URL to disk", () =>
  withDir(async (dir) => {
    let url = "";
    let verifier = "";
    let idToken = "";
    const transport: typeof fetch = async (_input, init) => {
      verifier = new URLSearchParams(init?.body as string).get("code_verifier")!;
      const response = await tokens(url);
      idToken = ((await response.clone().json()) as { id_token: string }).id_token;
      return response;
    };
    const session = await createChatGptSession(
      dir,
      (options) => beginChatGptLogin({ ...options, transport, keys }),
      async (): Promise<RevokeOutcome> => "refused",
      fast,
    );
    const attempt = await session.login("work");
    url = attempt.authorizationUrl;
    const completion = attempt.complete();
    await approve(url, "code-secret");
    expect(await completion).toBe(true);
    const auth = new URL(url);
    const secrets = [
      "access-secret",
      "refresh-secret",
      "code-secret",
      verifier,
      idToken,
      url,
      auth.searchParams.get("state")!,
      auth.searchParams.get("nonce")!,
      auth.searchParams.get("code_challenge")!,
    ];
    expect(secrets.every(Boolean)).toBe(true);
    const signedIn = await onDisk(dir);
    expect(await session.signout()).toBe(false);
    const signedOut = await onDisk(dir);
    expect(signedOut).toContain("revocation-unconfirmed");
    for (const secret of secrets) {
      expect(signedIn).not.toContain(secret);
      expect(signedOut).not.toContain(secret);
    }
  }));

it("keeps malformed refresh issuance uncertain even after access revocation and expiry", () =>
  withDir(async (dir) => {
    for (const value of [null, "", "x".repeat(32769)]) {
      const session = await createChatGptSession(
        dir,
        (options) =>
          beginChatGptLogin({
            ...options,
            transport: async () =>
              Response.json({ access_token: "access", refresh_token: value, expires_in: 1 }),
            keys,
          }),
        async () => "revoked",
        fast,
      );
      const attempt = await session.login("work");
      const done = expect(attempt.complete()).rejects.toThrow();
      await approve(attempt.authorizationUrl);
      await done;
      expect((await records(dir)).at(-1)).not.toHaveProperty("accessExpiresAt");
      expect(session.status().remoteUncertain).toBe(true);
    }
  }));

it("retains malformed access issuance after refresh revocation without a false expiry", () =>
  withDir(async (dir) => {
    for (const value of [null, "", "x".repeat(32769)]) {
      const session = await createChatGptSession(
        dir,
        (options) =>
          beginChatGptLogin({
            ...options,
            transport: async () =>
              Response.json({ access_token: value, refresh_token: "refresh", expires_in: 1 }),
            keys,
          }),
        async () => "revoked",
        fast,
      );
      const attempt = await session.login("work");
      const done = expect(attempt.complete()).rejects.toThrow();
      await approve(attempt.authorizationUrl);
      await done;
      expect((await records(dir)).at(-1)).toMatchObject({ state: "revocation-unconfirmed" });
      expect((await records(dir)).at(-1)).not.toHaveProperty("accessExpiresAt");
      expect((await createChatGptSession(dir)).status().remoteUncertain).toBe(true);
    }
  }));

it("retains access uncertainty after refresh revocation until access expiry", () =>
  withDir(async (dir) => {
    const expiresAt = Date.now() + 60000;
    const session = await createChatGptSession(
      dir,
      fakeLogin({ expiresAt }),
      async (token) => (token === "refresh" ? "revoked" : "refused"),
      fast,
    );
    await (await session.login("work")).complete();
    expect(await session.signout()).toBe(false);
    expect(await records(dir)).toMatchObject([{ accessExpiresAt: expiresAt }]);
    expect((await createChatGptSession(dir)).status().remoteUncertain).toBe(true);
  }));

it("keeps unknown token endpoint failures uncertain", () =>
  withDir(async (dir) => {
    for (const response of [
      new Response("rate limited", { status: 429 }),
      Response.json({ error: "other" }, { status: 400 }),
      Response.json({ error: "invalid_grant", access_token: "unexpected" }, { status: 400 }),
    ]) {
      const session = await createChatGptSession(dir, (options) =>
        beginChatGptLogin({ ...options, transport: async () => response, keys }),
      );
      const attempt = await session.login("work");
      const done = expect(attempt.complete()).rejects.toThrow();
      await approve(attempt.authorizationUrl);
      await done;
      expect(session.status().remoteUncertain).toBe(true);
      await session.acknowledgeRemoteDisconnect();
    }
  }));

it("blocks acknowledgement during late exchange cleanup", () =>
  withDir(async (dir) => {
    let releaseResponse!: (response: Response) => void;
    let releaseRevoke!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    const session = await createChatGptSession(
      dir,
      (options) =>
        beginChatGptLogin({
          ...options,
          keys,
          transport: async () =>
            new Promise<Response>((resolve) => {
              releaseResponse = resolve;
              started();
            }),
        }),
      async () => {
        await gate;
        return "revoked";
      },
      fast,
    );
    const attempt = await session.login("work");
    const done = expect(attempt.complete()).rejects.toThrow();
    await approve(attempt.authorizationUrl);
    await ready;
    await session.signout();
    await done;
    releaseResponse(Response.json({ access_token: "access", refresh_token: "refresh" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(session.acknowledgeRemoteDisconnect()).rejects.toThrow();
    releaseRevoke();
    await vi.waitFor(() => expect(session.status().remoteUncertain).toBe(false));
  }));
