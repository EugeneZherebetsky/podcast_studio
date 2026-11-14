import { AiSdkLlmProvider } from "../../src/providers/llm/ai-sdk.ts";

Object.defineProperty(AiSdkLlmProvider.prototype, "cacheIdentity", {
  get() { throw new Error("synthetic-provider-secret-47"); },
});
await import("../../src/cli/gen.ts");
