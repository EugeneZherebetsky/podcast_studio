// Verify identity before returning an in-memory login result.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const issuer = "https://auth.openai.com";
const openAiKeys = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));

export async function verifyChatGptIdentity(
  token: string,
  clientId: string,
  nonce: string,
  keys: JWTVerifyGetKey = openAiKeys,
): Promise<{ subject: string }> {
  if (!token || token.length > 32768 || !clientId || !nonce) throw new Error("Invalid identity");
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "aud", "sub", "exp", "nonce"],
  });
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.nonce !== nonce ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
    (payload.azp !== undefined && payload.azp !== clientId)
  )
    throw new Error("Invalid identity");
  return { subject: payload.sub };
}
