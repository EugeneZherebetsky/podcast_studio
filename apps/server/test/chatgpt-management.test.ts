import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatGptManagement } from "../src/chatgpt-management.ts";

describe("ChatGPT management boundary", () => {
  it("rejects hostile origins and exposes only safe status on loopback", async () => {
    const app = Fastify();
    const session = {
      status: () => ({
        active: null,
        accounts: [],
        planEnabled: false,
        expired: true,
        remoteUncertain: true,
        uncertain: [],
      }),
      login: async () => {
        throw new Error();
      },
      signout: async () => true,
      shutdown: async () => {},
      acknowledgeRemoteDisconnect: async () => {},
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
      expect(await response.json()).toMatchObject({
        active: null,
        planEnabled: false,
        expired: true,
        remoteUncertain: true,
      });
    } finally {
      await app.close();
    }
  });

  it("serializes login, cancels pending work and shuts down the session", async () => {
    const app = Fastify();
    let complete!: (value: boolean) => void;
    let shutdown = false;
    const session = {
      status: () => ({
        active: null,
        accounts: [],
        planEnabled: false,
        expired: false,
        remoteUncertain: false,
        uncertain: [],
      }),
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
      acknowledgeRemoteDisconnect: async () => {},
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
      status: () => ({
        active: null,
        accounts: [],
        planEnabled: false,
        expired: false,
        remoteUncertain: false,
        uncertain: [],
      }),
      login: async () => {
        throw new Error();
      },
      signout: async () => true,
      shutdown: async () => {},
      acknowledgeRemoteDisconnect: async () => {},
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

  it("guards acknowledgement like the other routes and requires explicit confirmation", async () => {
    const app = Fastify();
    let records = [
      {
        label: "work",
        cause: "signout-not-confirmed" as const,
        clientId: "client-secret",
        refreshToken: "refresh-secret",
      },
    ];
    let busy = false;
    let acknowledged = 0;
    registerChatGptManagement(app, {
      status: () => ({
        active: null,
        accounts: [],
        planEnabled: false,
        expired: false,
        remoteUncertain: records.length > 0,
        uncertain: records,
      }),
      login: async () => {
        throw new Error();
      },
      signout: async () => true,
      shutdown: async () => {},
      acknowledgeRemoteDisconnect: async () => {
        if (busy) throw new Error("busy");
        acknowledged++;
        records = [];
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error();
      const base = `http://127.0.0.1:${address.port}`;
      const post = (body: unknown, headers: Record<string, string> = { origin: base }) =>
        fetch(`${base}/api/chatgpt/acknowledge`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const confirm = { disconnectedInChatGptSettings: true };
      expect((await post(confirm, { origin: "http://evil.test" })).status).toBe(403);
      expect((await post(confirm, { origin: base, "x-forwarded-for": "127.0.0.1" })).status).toBe(
        403,
      );
      expect((await post(confirm, { origin: base, authorization: "Bearer x" })).status).toBe(403);
      expect((await post(confirm, {})).status).toBe(403);
      const status = await (
        await fetch(`${base}/api/chatgpt/status`, { headers: { origin: base } })
      ).text();
      expect(JSON.parse(status)).toMatchObject({
        remoteUncertain: true,
        uncertain: [{ label: "work", cause: "signout-not-confirmed" }],
      });
      expect(status).not.toMatch(/secret|clientId|refreshToken/);
      expect((await post({})).status).toBe(400);
      expect((await post({ disconnectedInChatGptSettings: "yes" })).status).toBe(400);
      busy = true;
      const refused = await post(confirm);
      expect(refused.status).toBe(409);
      expect(await refused.text()).not.toMatch(/secret/);
      expect(acknowledged).toBe(0);
      busy = false;
      const accepted = await post(confirm);
      expect(accepted.status).toBe(200);
      const text = await accepted.text();
      expect(text).not.toMatch(/secret|clientId|refreshToken/);
      expect(JSON.parse(text)).toMatchObject({ remoteUncertain: false, uncertain: [] });
      expect(acknowledged).toBe(1);
    } finally {
      await app.close();
    }
  });
});
