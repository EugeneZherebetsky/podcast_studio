import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyChatGptIdentity } from "../src/providers/llm/chatgpt-identity.ts";

describe("ChatGPT identity verification", () => {
  it("accepts only a signed, current identity bound to issuer, audience and nonce", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const makeToken = (claims: Record<string, unknown> = {}) =>
      new SignJWT({ nonce: "expected", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://auth.openai.com")
        .setAudience("issued")
        .setSubject("subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const token = await makeToken();
    expect(await verifyChatGptIdentity(token, "issued", "expected", keys)).toEqual({
      subject: "subject",
    });
    await expect(verifyChatGptIdentity(token, "other", "expected", keys)).rejects.toThrow();
    await expect(verifyChatGptIdentity(token, "issued", "wrong", keys)).rejects.toThrow();
    const { publicKey: otherKey } = await generateKeyPair("RS256");
    const wrongKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(otherKey)), kid: "test" }] });
    await expect(verifyChatGptIdentity(token, "issued", "expected", wrongKeys)).rejects.toThrow();
    const expired = await new SignJWT({ nonce: "expected" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://auth.openai.com")
      .setAudience("issued")
      .setSubject("subject")
      .setExpirationTime("1 second ago")
      .sign(privateKey);
    await expect(verifyChatGptIdentity(expired, "issued", "expected", keys)).rejects.toThrow();
    const wrongIssuer = await new SignJWT({ nonce: "expected" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://evil.example")
      .setAudience("issued")
      .setSubject("subject")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyChatGptIdentity(wrongIssuer, "issued", "expected", keys)).rejects.toThrow();
    const missingExpiry = await new SignJWT({ nonce: "expected" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://auth.openai.com")
      .setAudience("issued")
      .setSubject("subject")
      .sign(privateKey);
    await expect(verifyChatGptIdentity(missingExpiry, "issued", "expected", keys)).rejects.toThrow();
    const missingSubject = await new SignJWT({ nonce: "expected" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://auth.openai.com")
      .setAudience("issued")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyChatGptIdentity(missingSubject, "issued", "expected", keys)).rejects.toThrow();
  });
});
