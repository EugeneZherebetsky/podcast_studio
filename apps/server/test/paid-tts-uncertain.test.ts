import { expect, test, vi } from "vitest";
import { AzureTtsProvider } from "../src/providers/tts/azure.ts";
import { OpenAiTtsProvider } from "../src/providers/tts/openai.ts";
import { ExternalWorkUncertain, safeGenerationError } from "../src/safe-generation-error.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test.each(["azure", "openai"] as const)("%s does not retry a lost paid response", async (name) => {
  const dir = makeTempDir();
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("network error synthetic-secret"); });
  const opts = { dataDir: dir, fetch: fetcher, sleep: async () => {} };
  const provider = name === "azure" ? new AzureTtsProvider({ ...opts, subscriptionKey: "test" }) : new OpenAiTtsProvider({ ...opts, apiKey: "test" });
  try {
    const error = await provider.synthesize({ text: "hello", lang: "en", voice: "alloy", rate: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalWorkUncertain);
    expect(safeGenerationError(error)).toBe("Cloud TTS failed; the provider may have billed this request; external work may still be running; stop the server and follow manual recovery in SETUP.md");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  } finally { removeTempDir(dir); }
});

test.each(["azure", "openai"] as const)("%s does not retry timeouts or rate limits", async (name) => {
  for (const failure of ["timeout", "rate-limit"] as const) {
    const dir = makeTempDir();
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failure === "timeout") throw new DOMException("private", "TimeoutError");
      return new Response("private", { status: 429 });
    });
    const opts = { dataDir: dir, fetch: fetcher, sleep: async () => {} };
    const provider = name === "azure" ? new AzureTtsProvider({ ...opts, subscriptionKey: "test" }) : new OpenAiTtsProvider({ ...opts, apiKey: "test" });
    try {
      const error = await provider.synthesize({ text: "hello", lang: "en", voice: "alloy", rate: 1 }).catch((caught: unknown) => caught);
      if (failure === "timeout") expect(error).toBeInstanceOf(ExternalWorkUncertain);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { removeTempDir(dir); }
  }
});
