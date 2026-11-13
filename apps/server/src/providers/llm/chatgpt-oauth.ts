// Protocol preparation shared by the isolated login flow.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const resource = "https://api.openai.com/v1";
const dynamicClient = "dynamic_agent_client";
const random = () => randomBytes(32).toString("base64url");

export function startChatGptAuthorization(options: {
  port: number;
  hostId: string;
  clientId?: string;
}) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error("Invalid callback port");
  if (
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.hostId,
    )
  )
    throw new Error("Invalid host identifier");
  if (options.clientId !== undefined && (!options.clientId || options.clientId === dynamicClient))
    throw new Error("Invalid issued client ID");

  const redirectUri = `http://127.0.0.1:${options.port}/auth/callback`;
  const state = random();
  const nonce = random();
  const verifier = random();
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  const params = {
    client_id: options.clientId ?? dynamicClient,
    ext_agent_host_id: options.hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(options.clientId === undefined ? { agent_name_hint: "Podcast Studio" } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let completed = false;

  return {
    authorizationUrl: url.toString(),
    acceptCallback(
      target: string,
    ):
      | { kind: "denied" }
      | {
          kind: "code";
          code: string;
          clientId: string;
          verifier: string;
          nonce: string;
          redirectUri: string;
        } {
      if (completed || target.length > 8192 || !target.startsWith("/auth/callback?"))
        throw new Error("Invalid authorization callback");
      const callback = new URL(target, "http://127.0.0.1");
      if (callback.pathname !== "/auth/callback" || callback.hash)
        throw new Error("Invalid authorization callback");
      for (const key of ["state", "code", "client_id", "error", "scope"])
        if (callback.searchParams.getAll(key).length > 1)
          throw new Error("Invalid authorization callback");
      const returnedState = callback.searchParams.get("state") ?? "";
      const actual = Buffer.from(returnedState);
      const expected = Buffer.from(state);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error("Invalid authorization callback");
      const error = callback.searchParams.get("error");
      const code = callback.searchParams.get("code");
      const suppliedClient = callback.searchParams.get("client_id");
      if (error !== null) {
        if (error !== "access_denied" || code !== null || suppliedClient !== null)
          throw new Error("Invalid authorization callback");
        completed = true;
        return { kind: "denied" };
      }
      const clientId = options.clientId ?? suppliedClient;
      if (
        !code ||
        !clientId ||
        clientId === dynamicClient ||
        (options.clientId && suppliedClient !== null && suppliedClient !== options.clientId)
      )
        throw new Error("Invalid authorization callback");
      completed = true;
      return { kind: "code", code, clientId, verifier, nonce, redirectUri };
    },
  };
}
