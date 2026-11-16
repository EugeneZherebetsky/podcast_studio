import { connect } from "node:net";
import { localServiceUrl } from "./providers/local-url.ts";

export const SEARCH_UNREACHABLE = "SearXNG is unreachable. Start local SearXNG and check its URL in Local services, then try again; see Setup for instructions.";

/** Only checks TCP reachability; it cannot guarantee that search will work later. */
export async function preflightSearch(baseUrl: string): Promise<void> {
  const url = new URL(localServiceUrl(baseUrl));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => finish(false), 2000);
    function finish(ok: boolean) {
      clearTimeout(timer);
      socket.destroy();
      if (ok) resolve();
      else reject(new Error(SEARCH_UNREACHABLE));
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
