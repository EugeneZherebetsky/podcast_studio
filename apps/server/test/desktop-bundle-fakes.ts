// Used only by the separately built offline verification bundle, never by production.
import path from "node:path";
import { createFakeProviders } from "../src/providers/index.ts";
import { respond } from "./generation-fakes.ts";

export function createProviders(config: { DATA_DIR: string }) {
  const providers = createFakeProviders({ wavDir: path.join(config.DATA_DIR, "fake-wav") });
  providers.llm.enqueue(...Array.from({ length: 200 }, () => respond));
  return providers;
}
