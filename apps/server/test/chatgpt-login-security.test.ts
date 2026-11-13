import { request } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { beginChatGptLogin } from "../src/providers/llm/chatgpt-login.ts";

const hostId = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";
function callback(url: string) {
  const auth = new URL(url);
  const target = new URL(auth.searchParams.get("redirect_uri")!);
  target.searchParams.set("state", auth.searchParams.get("state")!);
  target.searchParams.set("code", "code");
  target.searchParams.set("client_id", "issued");
  return target;
}
function raw(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ChatGPT login boundaries", () => {
  it("rejects forged host, path, state and duplicate parameters without consuming the attempt", async () => {
    const transport = vi.fn<typeof fetch>();
    const login = await beginChatGptLogin({ hostId, transport });
    const target = callback(login.authorizationUrl);
    const port = Number(target.port);
    expect(await raw(port, target.pathname + target.search, "evil.test")).toBe(400);
    expect(await raw(port, "/wrong" + target.search, target.host)).toBe(400);
    expect(await raw(port, "/auth/callback?state=wrong&code=x&client_id=issued", target.host)).toBe(
      400,
    );
    expect(await raw(port, target.pathname + target.search + "&state=again", target.host)).toBe(
      400,
    );
    expect([400, 431]).toContain(
      await raw(
        port,
        target.pathname + target.search + "&padding=" + "x".repeat(8200),
        target.host,
      ),
    );
    const denied = new URL(target);
    denied.searchParams.delete("code");
    denied.searchParams.delete("client_id");
    denied.searchParams.set("error", "access_denied");
    expect((await fetch(denied)).status).toBe(200);
    expect(await login.result).toEqual({ kind: "denied" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects replay while exchange is in flight, and times out without leaking errors", async () => {
    const transport: typeof fetch = async () => new Promise(() => {});
    const login = await beginChatGptLogin({ hostId, transport, timeoutMs: 150 });
    const rejected = expect(login.result).rejects.toThrow("ChatGPT login failed");
    const target = callback(login.authorizationUrl);
    expect((await fetch(target)).status).toBe(200);
    expect((await fetch(target)).status).toBe(400);
    await rejected;
  });

  it("rejects redirects and never includes endpoint errors in the result", async () => {
    const login = await beginChatGptLogin({
      hostId,
      transport: async () =>
        new Response("private-token", { status: 302, headers: { location: "https://evil.test" } }),
    });
    const rejected = expect(login.result).rejects.toThrow("ChatGPT login failed");
    await fetch(callback(login.authorizationUrl));
    await rejected;
  });

  it("validates the nonce and granted scope rather than the callback scope", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    const keys = createLocalJWKSet({ keys: [jwk] });
    for (const wrongNonce of [false, true]) {
      let nonce = "";
      const transport: typeof fetch = async () => {
        const id = await new SignJWT({ nonce: wrongNonce ? "wrong" : nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer("https://auth.openai.com")
          .setAudience("issued")
          .setSubject("user")
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({
          access_token: "access",
          id_token: id,
          token_type: "Bearer",
          expires_in: 60,
          scope: "openid",
        });
      };
      const login = await beginChatGptLogin({ hostId, transport, keys });
      nonce = new URL(login.authorizationUrl).searchParams.get("nonce")!;
      const result = wrongNonce
        ? expect(login.result).rejects.toThrow("ChatGPT login failed")
        : login.result;
      const target = callback(login.authorizationUrl);
      target.searchParams.set("scope", "chatgpt.tokens.use.direct resource.invoke");
      await fetch(target);
      const value = await result;
      if (!wrongNonce && value && "kind" in value && value.kind === "success")
        expect(value.planEnabled).toBe(false);
    }
  });

  it("rejects an oversized token response", async () => {
    const login = await beginChatGptLogin({
      hostId,
      transport: async () => new Response("x".repeat(65537)),
    });
    const rejected = expect(login.result).rejects.toThrow("ChatGPT login failed");
    await fetch(callback(login.authorizationUrl));
    await rejected;
  });

  it("requires identity binding for a returning client", async () => {
    await expect(beginChatGptLogin({ hostId, clientId: "issued" })).rejects.toThrow(
      "expected identity",
    );
  });
});
