import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatGptManagement } from "../src/chatgpt-management.ts";

describe("ChatGPT management boundary", () => {
  it("rejects hostile origins and exposes only safe status on loopback", async () => {
    const app = Fastify();
    const session = {
      status: () => ({ active: null, accounts: [], planEnabled: false }),
      login: async () => {
        throw new Error();
      },
      signout: async () => true,
      shutdown: async () => {},
    };
    registerChatGptManagement(app, session);
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error();
      const base = `http://127.0.0.1:${address.port}`;
      expect(
        (await fetch(`${base}/api/chatgpt/status`, { headers: { origin: "http://evil.test" } }))
          .status,
      ).toBe(403);
      expect(
        (
          await fetch(`${base}/api/chatgpt/status`, {
            headers: { origin: base, "x-forwarded-for": "127.0.0.1" },
          })
        ).status,
      ).toBe(403);
      const response = await fetch(`${base}/api/chatgpt/status`, { headers: { origin: base } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ active: null, planEnabled: false });
    } finally {
      await app.close();
    }
  });

  it("serializes login, cancels pending work and shuts down the session", async () => {
    const app = Fastify();
    let complete!: (value: boolean) => void;
    let shutdown = false;
    const session = {
      status: () => ({ active: null, accounts: [], planEnabled: false }),
      login: async () => ({
        authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=example",
        complete: () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          }),
      }),
      signout: async () => {
        complete(false);
        return false;
      },
      shutdown: async () => {
        shutdown = true;
      },
    };
    registerChatGptManagement(app, session);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body = {}) =>
      fetch(`${base}/api/chatgpt/${path}`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const first = await post("login", { label: "test" });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=example",
      });
      expect((await post("login", { label: "other" })).status).toBe(409);
      expect(await (await post("signout")).json()).toEqual({ revoked: false });
      expect(await (await post("status")).json()).toMatchObject({ phase: "idle" });
    } finally {
      await app.close();
    }
    expect(shutdown).toBe(true);
  });

  it("rejects a wildcard listener even for a loopback peer", async () => {
    const app = Fastify();
    registerChatGptManagement(app, {
      status: () => ({ active: null, accounts: [], planEnabled: false }),
      login: async () => {
        throw new Error();
      },
      signout: async () => true,
      shutdown: async () => {},
    });
    await app.listen({ host: "0.0.0.0", port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error();
      const base = `http://127.0.0.1:${address.port}`;
      expect(
        (await fetch(`${base}/api/chatgpt/status`, { headers: { origin: base } })).status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
