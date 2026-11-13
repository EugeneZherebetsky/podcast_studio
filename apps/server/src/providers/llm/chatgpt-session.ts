import { generate, listModels } from "./chatgpt-inference.ts";
import { beginChatGptLogin } from "./chatgpt-login.ts";
import { openRegistrationStore } from "./chatgpt-registration.ts";

type Result = Awaited<Awaited<ReturnType<typeof beginChatGptLogin>>["result"]>;
type Success = Extract<Result, { kind: "success" }>;

async function revoke(token: string, clientId: string): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(10_000);
    const discovery = await fetch("https://auth.openai.com/.well-known/openid-configuration", {
      redirect: "error",
      signal,
    });
    if (!discovery.ok || !discovery.body || Number(discovery.headers.get("content-length")) > 65536)
      return false;
    const reader = discovery.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        return false;
      }
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const endpoint = new URL(
      (JSON.parse(text) as { revocation_endpoint: string }).revocation_endpoint,
    );
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "auth.openai.com" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      return false;
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: clientId }),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function createChatGptSession(
  directory: string,
  start = beginChatGptLogin,
  revokeSession = revoke,
) {
  const store = await openRegistrationStore(directory);
  let active: { label: string; credentials: Success } | undefined;
  let pending:
    { cancelled: boolean; close?: () => void; done: Promise<void>; finish: () => void } | undefined;
  let closed = false;
  let signingOut = false;
  async function cancelPending() {
    const current = pending;
    if (!current) return;
    current.cancelled = true;
    current.close?.();
    await current.done;
  }
  return {
    status() {
      return {
        active: active?.label ?? null,
        accounts: Object.keys(store.accounts).sort(),
        planEnabled: active?.credentials.planEnabled ?? false,
      };
    },
    async login(label: string) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(label)) throw new Error("Invalid account label");
      if (closed) throw new Error("Session closed");
      if (signingOut) throw new Error("Signout pending");
      if (pending) throw new Error("Login already pending");
      if (active) throw new Error("Sign out before starting another login");
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const current = {
        cancelled: false,
        close: undefined as (() => void) | undefined,
        done,
        finish,
      };
      pending = current;
      const cleanup = () => {
        if (pending === current) pending = undefined;
        current.finish();
      };
      try {
        const accounts = store.accounts;
        const account = Object.hasOwn(accounts, label) ? accounts[label] : undefined;
        const attempt = await start({
          hostId: store.hostId,
          ...(account ? { clientId: account.clientId, expectedSubject: account.subject } : {}),
        });
        let consumed = false;
        current.close = () => {
          attempt.close();
          if (!consumed) cleanup();
        };
        void attempt.result.catch(() => {
          if (!consumed) cleanup();
        });
        if (current.cancelled) {
          attempt.close();
          throw new Error("Login cancelled");
        }
        return {
          authorizationUrl: attempt.authorizationUrl,
          async complete() {
            if (consumed) throw new Error("Login already completed");
            consumed = true;
            try {
              const result = await attempt.result;
              if (current.cancelled) throw new Error("Login cancelled");
              if (result.kind === "denied") return false;
              await store.save(label, result.clientId, result.subject);
              if (current.cancelled) throw new Error("Login cancelled");
              active = { label, credentials: result };
              return true;
            } finally {
              cleanup();
            }
          },
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async models(signal?: AbortSignal) {
      if (!active?.credentials.planEnabled) throw new Error("A plan-enabled session is required");
      return listModels(active.credentials.accessToken, { signal });
    },
    async generate(model: string, prompt: string, signal?: AbortSignal) {
      if (!active?.credentials.planEnabled) throw new Error("A plan-enabled session is required");
      return generate(active.credentials.accessToken, model, prompt, { signal });
    },
    async generateStructured(
      model: string,
      system: string,
      prompt: string,
      schema: object,
      signal?: AbortSignal,
    ) {
      if (!active?.credentials.planEnabled) throw new Error("A plan-enabled session is required");
      return generate(active.credentials.accessToken, model, prompt, {
        signal,
        structured: { system, schema },
      });
    },
    async shutdown() {
      closed = true;
      await cancelPending();
      active = undefined;
    },
    async signout() {
      if (signingOut) throw new Error("Signout pending");
      signingOut = true;
      try {
        await cancelPending();
        const session = active;
        active = undefined;
        if (!session?.credentials.refreshToken) return true;
        return await revokeSession(session.credentials.refreshToken, session.credentials.clientId);
      } finally {
        signingOut = false;
      }
    },
  };
}
