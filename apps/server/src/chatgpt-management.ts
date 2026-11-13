import type { FastifyInstance } from "fastify";
import type { createChatGptSession } from "./providers/llm/chatgpt-session.ts";

type Session = Pick<
  Awaited<ReturnType<typeof createChatGptSession>>,
  "status" | "login" | "signout" | "shutdown"
>;

export function registerChatGptManagement(app: FastifyInstance, session: Session) {
  let phase: "idle" | "starting" | "pending" | "failed" = "idle";
  let generation = 0;
  let closing = false;
  app.addHook("onClose", async () => {
    closing = true;
    generation++;
    await session.shutdown();
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.split("?")[0]?.startsWith("/api/chatgpt/")) return;
    reply.header("cache-control", "no-store");
    const address = app.server.address();
    const peer = request.raw.socket.remoteAddress;
    const host = request.headers.host;
    const forwarded = Object.keys(request.headers).some(
      (key) => key === "forwarded" || key.startsWith("x-forwarded-") || key === "via",
    );
    if (
      !address ||
      typeof address === "string" ||
      !["127.0.0.1", "::1"].includes(address.address) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
      forwarded ||
      host !== `${address.address === "::1" ? "[::1]" : address.address}:${address.port}` ||
      request.headers.origin !== `http://${host}` ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      request.headers.authorization !== undefined
    ) {
      return reply
        .code(403)
        .send({ error: "ChatGPT management requires a direct same-origin loopback connection" });
    }
  });
  const status = () => {
    const value = session.status();
    return {
      active: value.active,
      accounts: value.accounts,
      planEnabled: value.planEnabled,
      expired: value.expired,
      remoteUncertain: value.remoteUncertain,
      phase,
    };
  };
  app.get("/api/chatgpt/status", async () => status());
  app.post("/api/chatgpt/status", async () => status());
  app.post("/api/chatgpt/login", async (request, reply) => {
    const body = request.body as { label?: unknown } | null;
    if (!body || typeof body.label !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(body.label))
      return reply.code(400).send({ error: "Invalid account label" });
    if (phase === "pending" || phase === "starting" || closing)
      return reply.code(409).send({ error: "Login already pending" });
    phase = "starting";
    const current = ++generation;
    let started = false;
    try {
      const attempt = await session.login(body.label);
      started = true;
      if (current !== generation || closing)
        return reply.code(409).send({ error: "Login cancelled" });
      const url = new URL(attempt.authorizationUrl);
      if (
        url.protocol !== "https:" ||
        url.host !== "auth.openai.com" ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/api/accounts/authorize"
      )
        throw new Error("Invalid authorization URL");
      phase = "pending";
      void attempt.complete().then(
        (success) => {
          if (current === generation) phase = success ? "idle" : "failed";
        },
        () => {
          if (current === generation) phase = "failed";
        },
      );
      return { authorizationUrl: url.toString() };
    } catch {
      if (current === generation) {
        phase = "failed";
        if (started) await session.signout().catch(() => false);
      }
      return reply.code(400).send({ error: "Could not start ChatGPT sign-in" });
    }
  });
  app.post("/api/chatgpt/signout", async (_request, reply) => {
    generation++;
    phase = "idle";
    try {
      return { revoked: await session.signout() };
    } catch {
      return reply.code(409).send({ error: "Sign-out is already in progress" });
    }
  });
}
