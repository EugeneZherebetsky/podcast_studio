import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startChatGptAuthorization } from "../src/providers/llm/chatgpt-oauth.ts";

const host = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";

describe("ChatGPT authorization foundation", () => {
  it("constructs the documented dynamic registration request and S256 challenge", () => {
    const attempt = startChatGptAuthorization({ port: 1455, hostId: host });
    const url = new URL(attempt.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("Podcast Studio");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(host);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state");
    const result = attempt.acceptCallback(
      `/auth/callback?code=code&client_id=issued&state=${state}`,
    );
    expect(result.kind).toBe("code");
    if (result.kind !== "code") throw new Error("expected code");
    expect(createHash("sha256").update(result.verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(result.nonce).toBe(url.searchParams.get("nonce"));
    expect(result.clientId).toBe("issued");
  });

  it("rejects forged and malformed callbacks without consuming the real attempt", () => {
    const attempt = startChatGptAuthorization({ port: 1234, hostId: host });
    const state = new URL(attempt.authorizationUrl).searchParams.get("state");
    for (const callback of [
      `/auth/callback?state=wrong&code=x&client_id=issued`,
      `/auth/callback?state=${state}&state=${state}&code=x&client_id=issued`,
      `/auth/callback?state=${state}&code=x&code=y&client_id=issued`,
      `/auth/callback?state=${state}&code=x`,
      `/auth/callback?state=${state}&code=x&client_id=dynamic_agent_client`,
      `http://evil.test/auth/callback?state=${state}&code=x&client_id=issued`,
      `/wrong?state=${state}&code=x&client_id=issued`,
      `/auth/callback?state=${state}&code=x&client_id=issued&error=access_denied`,
    ])
      expect(() => attempt.acceptCallback(callback)).toThrow();
    expect(
      attempt.acceptCallback(`/auth/callback?state=${state}&code=x&client_id=issued`).kind,
    ).toBe("code");
    expect(() =>
      attempt.acceptCallback(`/auth/callback?state=${state}&code=x&client_id=issued`),
    ).toThrow();
  });

  it("binds returning registration and handles consent denial once", () => {
    const attempt = startChatGptAuthorization({ port: 1234, hostId: host, clientId: "issued" });
    const url = new URL(attempt.authorizationUrl);
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    const state = url.searchParams.get("state");
    expect(() =>
      attempt.acceptCallback(`/auth/callback?state=${state}&code=x&client_id=other`),
    ).toThrow();
    expect(attempt.acceptCallback(`/auth/callback?state=${state}&error=access_denied`)).toEqual({
      kind: "denied",
    });
    expect(() =>
      attempt.acceptCallback(`/auth/callback?state=${state}&error=access_denied`),
    ).toThrow();
  });

  it("requires a valid port and opaque v4 host identifier", () => {
    for (const port of [0, 65536, 1.5])
      expect(() => startChatGptAuthorization({ port, hostId: host })).toThrow();
    expect(() => startChatGptAuthorization({ port: 1455, hostId: "email@example.com" })).toThrow();
  });

  it("generates independent secrets per attempt", () => {
    const a = new URL(startChatGptAuthorization({ port: 1455, hostId: host }).authorizationUrl);
    const b = new URL(startChatGptAuthorization({ port: 1455, hostId: host }).authorizationUrl);
    for (const key of ["state", "nonce", "code_challenge"])
      expect(a.searchParams.get(key)).not.toBe(b.searchParams.get(key));
  });
});
