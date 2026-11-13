import { randomUUID } from "node:crypto";
import { generate, listModels } from "./chatgpt-inference.ts";
import { beginChatGptLogin, type ExchangeEnd } from "./chatgpt-login.ts";
import { openRegistrationStore, type GrantRecord } from "./chatgpt-registration.ts";

type Result = Awaited<Awaited<ReturnType<typeof beginChatGptLogin>>["result"]>;
type Success = Extract<Result, { kind: "success" }>;

/** "revoked": empty HTTP 200. "retryable": network failure or 5xx. "refused": anything else. */
export type RevokeOutcome = "revoked" | "retryable" | "refused";
type Revoke = (
  token: string,
  clientId: string,
  hint: string,
  signal: AbortSignal,
) => Promise<RevokeOutcome>;
type Credentials = {
  clientId: string;
  refreshToken?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  refreshUnusable?: boolean;
};
export type UncertainGrant = {
  label: string;
  cause: "stopped-while-signed-in" | "signout-not-confirmed";
};

export async function revokeToken(
  token: string,
  clientId: string,
  hint = "refresh_token",
  signal?: AbortSignal,
): Promise<RevokeOutcome> {
  const timeout = AbortSignal.timeout(10_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let endpoint: URL;
  try {
    const discovery = await fetch("https://auth.openai.com/.well-known/openid-configuration", {
      redirect: "error",
      signal: bounded,
    });
    if (discovery.status >= 500) return "retryable";
    if (!discovery.ok || !discovery.body || Number(discovery.headers.get("content-length")) > 65536)
      return "refused";
    const reader = discovery.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        return "refused";
      }
      chunks.push(part.value);
    }
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      endpoint = new URL((JSON.parse(text) as { revocation_endpoint: string }).revocation_endpoint);
    } catch {
      return "refused";
    }
  } catch {
    return "retryable";
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "auth.openai.com" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    return "refused";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: bounded,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) return "revoked";
    return response.status >= 500 ? "retryable" : "refused";
  } catch {
    return "retryable";
  }
}

export async function createChatGptSession(
  directory: string,
  start = beginChatGptLogin,
  revokeSession: Revoke = revokeToken,
  options: { retryDelaysMs?: number[]; signoutBudgetMs?: number; shutdownBudgetMs?: number } = {},
) {
  const retryDelays = options.retryDelaysMs ?? [500, 1500, 4000];
  const signoutPolicy = {
    attempts: retryDelays.length + 1,
    budgetMs: options.signoutBudgetMs ?? 15_000,
  };
  const shutdownPolicy = { attempts: 1, budgetMs: options.shutdownBudgetMs ?? 3_000 };
  const store = await openRegistrationStore(directory);
  let active:
    { label: string; credentials: Success; expiresAt: number; grantId: string } | undefined;
  let pending:
    | {
        cancelled: boolean;
        close?: () => void;
        done: Promise<void>;
        finish: () => void;
        grantId?: string;
      }
    | undefined;
  let closed = false;
  let signingOut = false;
  let stopping: Promise<void> | undefined;
  // Records whose token exchange has started in this process and has not yet ended.
  const exchanging = new Set<string>();
  // Set when a record update could not be written, so this process still warns.
  let unrecorded = false;
  let writes: Promise<unknown> = Promise.resolve();
  function persist(change: (current: GrantRecord[]) => GrantRecord[]) {
    const next = writes.then(() => store.updateGrants(change));
    writes = next.catch(() => {});
    return next;
  }
  async function createGrant(label: string, clientId: string) {
    const id = randomUUID();
    await persist((current) => [
      ...current,
      { id, label, clientId, state: "grant-may-exist", at: Date.now() },
    ]);
    return id;
  }
  async function removeGrant(id: string | undefined) {
    if (!id) return;
    // A failed removal leaves the record, which keeps warning: the safe direction.
    await persist((current) => current.filter((record) => record.id !== id)).catch(() => {});
  }
  async function markUnconfirmed(
    id: string | undefined,
    label: string,
    clientId: string,
    accessExpiresAt?: number,
  ) {
    const record: GrantRecord = {
      id: id ?? randomUUID(),
      label,
      clientId,
      state: "revocation-unconfirmed",
      at: Date.now(),
      ...(accessExpiresAt !== undefined ? { accessExpiresAt } : {}),
    };
    try {
      await persist((current) => [...current.filter((item) => item.id !== record.id), record]);
    } catch {
      unrecorded = true;
    }
  }
  async function revokeBounded(
    token: string,
    clientId: string,
    hint: string,
    attempts: number,
    deadline: number,
  ) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const signal = AbortSignal.timeout(remaining);
      const outcome = await Promise.race([
        revokeSession(token, clientId, hint, signal).catch((): RevokeOutcome => "retryable"),
        new Promise<RevokeOutcome>((resolve) =>
          signal.addEventListener("abort", () => resolve("retryable"), { once: true }),
        ),
      ]);
      if (outcome === "revoked") return true;
      if (outcome === "refused") return false;
      const wait = Math.min(retryDelays[attempt] ?? 0, deadline - Date.now());
      if (attempt + 1 < attempts && wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return false;
  }
  /**
   * Both credentials must be resolved; access expiry bounds only access uncertainty.
   * A missing usable refresh token cannot resolve malformed refresh issuance.
   */
  async function discard(
    credentials: Credentials,
    grantId: string | undefined,
    label: string,
    policy = closed ? shutdownPolicy : signoutPolicy,
  ) {
    const deadline = Date.now() + policy.budgetMs;
    const { refreshToken, accessToken, clientId } = credentials;
    const [refreshRevoked, accessRevoked] = await Promise.all([
      refreshToken
        ? revokeBounded(refreshToken, clientId, "refresh_token", policy.attempts, deadline)
        : Promise.resolve(false),
      accessToken
        ? revokeBounded(
            accessToken,
            clientId,
            "access_token",
            refreshToken ? 1 : policy.attempts,
            deadline,
          )
        : Promise.resolve(false),
    ]);
    const refreshResolved = !credentials.refreshUnusable && (!refreshToken || refreshRevoked);
    const accessResolved =
      !accessToken ||
      accessRevoked ||
      (credentials.accessExpiresAt !== undefined && credentials.accessExpiresAt <= Date.now());
    const confirmed = refreshResolved && accessResolved;
    if (confirmed) await removeGrant(grantId);
    else
      await markUnconfirmed(
        grantId,
        label,
        clientId,
        refreshResolved ? credentials.accessExpiresAt : undefined,
      );
    return confirmed;
  }
  const fromSuccess = (result: Success): Credentials => ({
    clientId: result.clientId,
    accessToken: result.accessToken,
    ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    accessExpiresAt: result.expiresAt ?? Date.now() + result.expiresIn * 1000,
  });
  const expired = () => !!active && Date.now() >= active.expiresAt;
  const requireAccess = () => {
    if (expired()) throw new Error("ChatGPT session expired; sign out and sign in again");
    if (!active?.credentials.planEnabled) throw new Error("A plan-enabled session is required");
    return active.credentials.accessToken;
  };
  // Records held by this process's live session or by its exchange still in progress.
  function held() {
    const ids = new Set<string>();
    if (active) ids.add(active.grantId);
    if (pending?.grantId) ids.add(pending.grantId);
    return ids;
  }
  function uncertain(): UncertainGrant[] {
    const now = Date.now();
    const ids = held();
    const seen = new Map<string, UncertainGrant>();
    for (const record of store.grants()) {
      if (record.state === "grant-may-exist" && ids.has(record.id)) continue;
      if (record.accessExpiresAt !== undefined && record.accessExpiresAt <= now) continue;
      const cause =
        record.state === "grant-may-exist" ? "stopped-while-signed-in" : "signout-not-confirmed";
      seen.set(`${record.label}\n${cause}`, { label: record.label, cause });
    }
    return [...seen.values()].sort(
      (a, b) => a.label.localeCompare(b.label) || a.cause.localeCompare(b.cause),
    );
  }
  const remoteUncertain = () => unrecorded || uncertain().length > 0;
  async function cancelPending() {
    const current = pending;
    if (!current) return;
    current.cancelled = true;
    current.close?.();
    await current.done;
  }
  return {
    status() {
      const affected = uncertain();
      return {
        active: active?.label ?? null,
        accounts: Object.keys(store.accounts).sort(),
        planEnabled: !expired() && (active?.credentials.planEnabled ?? false),
        expired: expired(),
        remoteUncertain: unrecorded || affected.length > 0,
        uncertain: affected,
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
        grantId: undefined as string | undefined,
        clientId: undefined as string | undefined,
      };
      pending = current;
      const cleanup = () => {
        if (pending === current) pending = undefined;
        current.finish();
      };
      // The exchange has produced a result (or the session took over the outcome).
      const settle = () => {
        if (current.grantId) exchanging.delete(current.grantId);
      };
      try {
        const accounts = store.accounts;
        const account = Object.hasOwn(accounts, label) ? accounts[label] : undefined;
        const attempt = await start({
          hostId: store.hostId,
          onExchange: async (clientId: string) => {
            if (current.cancelled) throw new Error("Login cancelled");
            // Durable before the code is sent: if this write fails, the request is not sent.
            const id = await createGrant(label, clientId);
            current.grantId = id;
            current.clientId = clientId;
            exchanging.add(id);
          },
          onExchangeEnd: async (end: ExchangeEnd) => {
            const id = current.grantId;
            try {
              if (end.kind === "no-tokens") await removeGrant(id);
              else if (end.kind === "unknown") {
                if (id && current.clientId) await markUnconfirmed(id, label, current.clientId);
              } else await discard(end, id, label);
            } finally {
              if (id) exchanging.delete(id);
            }
          },
          ...(account ? { clientId: account.clientId, expectedSubject: account.subject } : {}),
        });
        let consumed = false;
        current.close = () => {
          attempt.close();
          // Cancelled while the code may be at OpenAI: unconfirmed until the exchange ends.
          if (current.grantId && exchanging.has(current.grantId) && current.clientId)
            void markUnconfirmed(current.grantId, label, current.clientId);
          if (!consumed) {
            consumed = true;
            void attempt.result
              .then(
                async (result) => {
                  if (result.kind === "success") {
                    try {
                      await discard(fromSuccess(result), current.grantId, label);
                    } finally {
                      settle();
                    }
                  }
                },
                () => {},
              )
              .finally(cleanup);
          }
        };
        void attempt.result.catch(() => {
          if (!consumed) cleanup();
        });
        if (current.cancelled) {
          current.close();
          await current.done;
          throw new Error("Login cancelled");
        }
        return {
          authorizationUrl: attempt.authorizationUrl,
          async complete() {
            if (current.cancelled) throw new Error("Login cancelled");
            if (consumed) throw new Error("Login already completed");
            consumed = true;
            let acquired: Success | undefined;
            let received = false;
            try {
              const result = await attempt.result;
              if (result.kind === "success") {
                acquired = result;
                received = true;
              }
              if (current.cancelled) throw new Error("Login cancelled");
              if (result.kind === "denied") return false;
              // A login implementation that skipped onExchange still leaves evidence.
              current.grantId ??= await createGrant(label, result.clientId);
              await store.save(label, result.clientId, result.subject);
              if (current.cancelled) throw new Error("Login cancelled");
              active = {
                label,
                credentials: result,
                expiresAt: result.expiresAt ?? Date.now() + result.expiresIn * 1000,
                grantId: current.grantId,
              };
              acquired = undefined;
              return true;
            } catch (error) {
              if (acquired) await discard(fromSuccess(acquired), current.grantId, label);
              throw error;
            } finally {
              if (received) settle();
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
      return listModels(requireAccess(), { signal });
    },
    async generate(model: string, prompt: string, signal?: AbortSignal) {
      return generate(requireAccess(), model, prompt, { signal });
    },
    async generateStructured(
      model: string,
      system: string,
      prompt: string,
      schema: object,
      signal?: AbortSignal,
    ) {
      return generate(requireAccess(), model, prompt, {
        signal,
        structured: { system, schema },
      });
    },
    /** Attempts revocation once, within a short bound, so closing the server cannot hang. */
    shutdown() {
      closed = true;
      stopping ??= (async () => {
        await cancelPending();
        const session = active;
        active = undefined;
        if (session)
          await discard(
            fromSuccess(session.credentials),
            session.grantId,
            session.label,
            shutdownPolicy,
          );
        await writes;
      })();
      return stopping;
    },
    async signout() {
      if (signingOut) throw new Error("Signout pending");
      signingOut = true;
      try {
        await cancelPending();
        const session = active;
        active = undefined;
        if (session)
          await discard(fromSuccess(session.credentials), session.grantId, session.label);
        await writes;
        return !remoteUncertain();
      } finally {
        signingOut = false;
      }
    },
    /**
     * Records the user's statement that they disconnected the app in ChatGPT Settings. This is
     * not verification; it only clears the local evidence of possible outstanding grants.
     */
    async acknowledgeRemoteDisconnect() {
      if (closed || active || pending || signingOut || exchanging.size > 0)
        throw new Error("Sign out or cancel sign-in first");
      const ids = held();
      await persist((current) => current.filter((record) => ids.has(record.id)));
      unrecorded = false;
    },
  };
}
