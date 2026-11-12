// Pin localhost to a literal address so DNS or hosts-file changes cannot redirect private data.
export function localServiceUrl(value: string): string {
  const authority = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?=\/|$)/i;
  if (!authority.test(value))
    throw new Error("Local service URL must use a loopback address without credentials");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid local service URL: expected a loopback URL");
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      "Local service URL must use a loopback address without credentials or fragments",
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString().replace(/\/$/, "");
}

export const localFetch: typeof fetch = (input, init) => {
  if (input instanceof Request) throw new Error("Local service fetch requires an explicit URL");
  const url = localServiceUrl(typeof input === "string" ? input : input.href);
  return globalThis.fetch(url, { ...init, redirect: "error" });
};
