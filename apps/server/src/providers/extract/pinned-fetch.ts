import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Connect only to the validated address while retaining the URL's Host and TLS identity. */
export function pinnedFetch(
  url: URL,
  address: { address: string; family: number },
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        headers: { ...headers, "Accept-Encoding": "gzip, deflate, br" },
        signal,
        // Node may request all addresses when IPv4/IPv6 auto-selection is enabled.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      },
      (incoming) => {
        let stream: Readable = incoming;
        try {
          const status = incoming.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          // Redirects and no-body statuses must not leave an unread socket behind.
          if (
            (status >= 300 && status < 400) ||
            status === 204 ||
            status === 205 ||
            status === 304
          ) {
            incoming.destroy();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : null;
          if (encoding && encoding !== "identity" && !decoder) {
            incoming.destroy();
            reject(new Error("Unsupported content encoding"));
            return;
          }
          if (decoder) {
            incoming.on("error", (error) => decoder.destroy(error));
            stream = incoming.pipe(decoder);
            decoder.on("close", () => incoming.destroy());
          }
          resolve(
            new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
              status,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          stream.destroy();
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end();
  });
}
