import { createServer } from "node:http";
import type { JWTVerifyGetKey } from "jose";
import { verifyChatGptIdentity } from "./chatgpt-identity.ts";
import { startChatGptAuthorization } from "./chatgpt-oauth.ts";

const endpoint = "https://auth.openai.com/api/accounts/oauth/token";
const resource = "https://api.openai.com/v1";

type LoginResult =
  | { kind: "denied" }
  | {
      kind: "success";
      subject: string;
      clientId: string;
      accessToken: string;
      refreshToken?: string;
      idToken: string;
      expiresIn: number;
      expiresAt?: number;
      scopes: string[];
      planEnabled: boolean;
    };

/**
 * How a token exchange ended when its credentials were not handed to the caller.
 * "no-tokens": the request was never sent or a trusted OAuth error confirms no issuance.
 * "unknown": the request may have reached OpenAI but no response was read (network, timeout, abort).
 * "discard": tokens were received but rejected or arrived too late; the caller must revoke them.
 */
export type ExchangeEnd =
  | { kind: "no-tokens" }
  | { kind: "unknown" }
  | {
      kind: "discard";
      clientId: string;
      refreshToken?: string;
      accessToken?: string;
      accessExpiresAt?: number;
      refreshUnusable?: boolean;
    };

export async function beginChatGptLogin(options: {
  hostId: string;
  clientId?: string;
  expectedSubject?: string;
  transport?: typeof fetch;
  keys?: JWTVerifyGetKey;
  timeoutMs?: number;
  /** Awaited before the authorization code is sent; if it throws, the code is never sent. */
  onExchange?: (clientId: string) => Promise<void>;
  /** Awaited once when an exchange that passed onExchange ends without delivering a result. */
  onExchangeEnd?: (end: ExchangeEnd) => Promise<void>;
}): Promise<{ authorizationUrl: string; result: Promise<LoginResult>; close: () => void }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new Error("Invalid login timeout");
  if (options.clientId && !options.expectedSubject)
    throw new Error("Returning login requires an expected identity");
  let resolveResult!: (result: LoginResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<LoginResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const abort = new AbortController();
  let finished = false;
  let exchanging = false;
  const deadline = Date.now() + timeoutMs;
  let attempt: ReturnType<typeof startChatGptAuthorization>;
  const finish = (value?: LoginResult) => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    abort.abort();
    server.close();
    if (value && Date.now() < deadline) {
      resolveResult(value);
      return true;
    }
    rejectResult(new Error("ChatGPT login failed"));
    return false;
  };
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        Connection: "close",
      });
      res.end(text);
    };
    if (Date.now() >= deadline) {
      reply(400, "Invalid request.");
      finish();
      return;
    }
    if (
      finished ||
      exchanging ||
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${port}` ||
      req.headers["content-length"] ||
      req.headers["transfer-encoding"]
    ) {
      reply(400, "Invalid request.");
      return;
    }
    let callback: ReturnType<typeof attempt.acceptCallback>;
    try {
      callback = attempt.acceptCallback(req.url ?? "");
    } catch {
      reply(400, "Invalid request.");
      return;
    }
    exchanging = true;
    reply(200, "You may close this window and return to the application.");
    if (callback.kind === "denied") {
      finish({ kind: "denied" });
      return;
    }
    void (async () => {
      try {
        await options.onExchange?.(callback.clientId);
      } catch {
        // The durable record could not be written: never send the code; it simply expires.
        finish();
        return;
      }
      let refreshToken: string | undefined;
      let accessToken: string | undefined;
      let accessExpiresAt: number | undefined;
      let refreshUnusable = false;
      let delivered = false;
      let outcome: "no-tokens" | "unknown" = "unknown";
      try {
        if (finished) {
          outcome = "no-tokens";
          throw new Error("Login cancelled");
        }
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: callback.clientId,
          code: callback.code,
          code_verifier: callback.verifier,
          redirect_uri: callback.redirectUri,
          resource,
        });
        const exchangeStartedAt = Date.now();
        const response = await (options.transport ?? fetch)(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: body.toString(),
          signal: abort.signal,
        });
        if ((!response.ok && response.status !== 400) || response.redirected || !response.body)
          throw new Error("Exchange failed");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 65536) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          chunks.push(part.value);
        }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!data || typeof data !== "object") throw new Error("Invalid response");
        const token = data as Record<string, unknown>;
        if (response.status === 400) {
          const allowed = [
            "invalid_request",
            "invalid_client",
            "invalid_grant",
            "unauthorized_client",
            "unsupported_grant_type",
            "invalid_scope",
          ];
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
              "application/json" &&
            typeof token.error === "string" &&
            allowed.includes(token.error) &&
            Object.keys(token).every((key) =>
              ["error", "error_description", "error_uri"].includes(key),
            ) &&
            Object.values(token).every((value) => typeof value === "string")
          )
            outcome = "no-tokens";
          throw new Error("Exchange refused");
        }
        refreshUnusable =
          Object.hasOwn(token, "refresh_token") &&
          (typeof token.refresh_token !== "string" ||
            !token.refresh_token ||
            token.refresh_token.length > 32768);

        if (
          typeof token.access_token === "string" &&
          token.access_token.length > 0 &&
          token.access_token.length <= 32768
        )
          accessToken = token.access_token;
        if (
          typeof token.refresh_token === "string" &&
          token.refresh_token.length > 0 &&
          token.refresh_token.length <= 32768
        )
          refreshToken = token.refresh_token;
        if (
          typeof token.expires_in === "number" &&
          Number.isSafeInteger(token.expires_in) &&
          token.expires_in > 0
        )
          accessExpiresAt = exchangeStartedAt + token.expires_in * 1000;
        if (
          typeof token.access_token !== "string" ||
          !token.access_token ||
          token.access_token.length > 32768 ||
          typeof token.id_token !== "string" ||
          typeof token.scope !== "string" ||
          token.scope.length > 8192 ||
          typeof token.token_type !== "string" ||
          token.token_type.toLowerCase() !== "bearer" ||
          typeof token.expires_in !== "number" ||
          !Number.isSafeInteger(token.expires_in) ||
          token.expires_in <= 0 ||
          (token.refresh_token !== undefined &&
            (typeof token.refresh_token !== "string" ||
              !token.refresh_token ||
              token.refresh_token.length > 32768))
        )
          throw new Error("Invalid response");
        const identity = await verifyChatGptIdentity(
          token.id_token,
          callback.clientId,
          callback.nonce,
          options.keys,
        );
        if (options.expectedSubject && identity.subject !== options.expectedSubject)
          throw new Error("Identity mismatch");
        const scopes = token.scope.split(/\s+/).filter(Boolean);
        delivered = finish({
          kind: "success",
          subject: identity.subject,
          clientId: callback.clientId,
          accessToken: token.access_token,
          idToken: token.id_token,
          ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
          expiresIn: token.expires_in,
          expiresAt: exchangeStartedAt + token.expires_in * 1000,
          scopes,
          planEnabled:
            scopes.includes("chatgpt.tokens.use.direct") && scopes.includes("resource.invoke"),
        });
      } finally {
        if (!delivered) {
          const end: ExchangeEnd =
            refreshToken || accessToken
              ? {
                  kind: "discard",
                  clientId: callback.clientId,
                  ...(refreshToken ? { refreshToken } : {}),
                  ...(refreshUnusable ? { refreshUnusable: true } : {}),
                  ...(accessToken ? { accessToken } : {}),
                  ...(accessExpiresAt !== undefined ? { accessExpiresAt } : {}),
                }
              : { kind: outcome };
          await options.onExchangeEnd?.(end).catch(() => {});
        }
      }
    })().catch(() => finish());
  });
  server.requestTimeout = Math.min(timeoutMs, 10_000);
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.setTimeout(Math.min(timeoutMs, 10_000), (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Listener failed");
  }
  const port = address.port;
  try {
    attempt = startChatGptAuthorization({
      port,
      hostId: options.hostId,
      clientId: options.clientId,
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const timer = setTimeout(() => finish(), timeoutMs);
  return { authorizationUrl: attempt.authorizationUrl, result, close: () => finish() };
}
