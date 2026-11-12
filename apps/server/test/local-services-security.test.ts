import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { parseConfig } from "shared";
import { z } from "zod";
import { createAiSdkLlmProvider } from "../src/providers/llm/ai-sdk.ts";
import { SearxngSearchProvider } from "../src/providers/search/searxng.ts";
import { localServiceUrl } from "../src/providers/local-url.ts";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

describe("local service boundaries", () => {
  test("pins localhost to IPv4 without DNS and supports literal IPv6", () => {
    expect(localServiceUrl("http://localhost:1234/v1")).toBe("http://127.0.0.1:1234/v1");
    expect(localServiceUrl("http://[::1]:1234/v1")).toBe("http://[::1]:1234/v1");
  });
  test("rejects external, credentialed and malformed endpoints for both providers", () => {
    for (const url of [
      "http://example.com",
      "http://localhost.evil",
      "http://user:pass@localhost",
      "http://127.1",
      "http://0x7f000001",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => new SearxngSearchProvider({ baseUrl: url })).toThrow();
      const config = { ...parseConfig({ PROFILE: "local" }), OLLAMA_BASE_URL: url };
      expect(() => createAiSdkLlmProvider(config, "ollama", { env: {} })).toThrow();
    }
  });

  test("never forwards search queries or Ollama prompts across redirects", async () => {
    const leaked: string[] = [];
    const spy = createServer((req, res) => {
      leaked.push(req.url ?? "");
      req.on("data", (chunk) => leaked.push(String(chunk)));
      res.end("{}");
    });
    const spyUrl = await listen(spy);
    let localCalls = 0;
    const redirect = createServer((req, res) => {
      localCalls++;
      req.resume();
      res.writeHead(307, { location: `${spyUrl}/stolen` });
      res.end();
    });
    const localUrl = await listen(redirect);
    try {
      const search = new SearxngSearchProvider({ baseUrl: localUrl });
      await expect(search.search("private topic", { max: 1 })).rejects.toBeDefined();
      const config = parseConfig({ PROFILE: "local", OLLAMA_BASE_URL: `${localUrl}/v1` });
      const ollama = createAiSdkLlmProvider(config, "ollama", {
        env: { OLLAMA_BOUNDED_OUTPUT: "1" },
      });
      await expect(
        ollama.generateObject({
          slot: "main",
          system: "secret system",
          prompt: "private content",
          schema: z.object({ answer: z.string() }),
        }),
      ).rejects.toBeDefined();
      expect(localCalls).toBeGreaterThanOrEqual(2);
      expect(leaked).toEqual([]);
    } finally {
      redirect.closeAllConnections();
      spy.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => redirect.close(() => resolve())),
        new Promise<void>((resolve) => spy.close(() => resolve())),
      ]);
    }
  });
});
