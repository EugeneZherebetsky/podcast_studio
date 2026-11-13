import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { beginChatGptLogin } from "../src/providers/llm/chatgpt-login.ts";

const hostId = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";

describe("loopback ChatGPT login", () => {
  it("exchanges a valid callback without exposing credentials to the browser", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    const keys = createLocalJWKSet({ keys: [jwk] });
    let nonce = "";
    let redirectUri = "";
    let challenge = "";
    const transport: typeof fetch = async (input, init) => {
      expect(input).toBe("https://auth.openai.com/api/accounts/oauth/token");
      expect(init?.redirect).toBe("error");
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("example-code");
      expect(body.get("client_id")).toBe("issued");
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
        challenge,
      );
      expect(body.get("redirect_uri")).toBe(redirectUri);
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://auth.openai.com")
        .setAudience("issued")
        .setSubject("user")
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({
        access_token: "access-private",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid chatgpt.tokens.use.direct resource.invoke",
      });
    };
    const login = await beginChatGptLogin({ hostId, transport, keys });
    const url = new URL(login.authorizationUrl);
    nonce = url.searchParams.get("nonce")!;
    redirectUri = url.searchParams.get("redirect_uri")!;
    challenge = url.searchParams.get("code_challenge")!;
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("client_id", "issued");
    callback.searchParams.set("code", "example-code");
    const response = await fetch(callback);
    expect(await response.text()).not.toContain("access-private");
    const result = await login.result;
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.subject).toBe("user");
      expect(result.accessToken).toBe("access-private");
      expect(result.planEnabled).toBe(true);
    }
  });
});
