import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { ReadabilityExtractor } from "../src/providers/extract/readability.ts";

const html = readFileSync(new URL("./fixtures/article.html", import.meta.url));
const cert = readFileSync(new URL("./fixtures/tls/test-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/tls/test-key.pem", import.meta.url));
const roots = getCACertificates("default");
afterEach(() => {
  vi.restoreAllMocks();
  setDefaultCACertificates(roots);
});

test("pins each redirect's validated DNS result, keeps Host, and streams gzip", async () => {
  const hosts: string[] = [];
  const server = createHttpServer((req, res) => {
    hosts.push(req.headers.host ?? "");
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/article" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      res.end(gzipSync(req.url === "/bomb" ? Buffer.alloc(100_000, 65) : html));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const original = Socket.prototype.connect;
  const connected: string[] = [];
  // Route the already-selected public address into an isolated local test server.
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as {
      host?: string;
      lookup?: (
        host: string,
        options: { all: boolean },
        cb: (error: Error | null, address: string, family: number) => void,
      ) => void;
    };
    if (options.host === "news.example.com" && options.lookup) {
      options.lookup(options.host, { all: false }, (err, ip) => {
        if (err) throw err;
        connected.push(ip);
      });
      Object.assign(options, { host: "127.0.0.1", family: 4, lookup: undefined });
    }
    return Reflect.apply(original, this, args);
  } as typeof Socket.prototype.connect);
  const lookup = vi
    .fn()
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValueOnce([{ address: "2606:4700:4700::1111", family: 6 }]);
  try {
    const result = await new ReadabilityExtractor({ lookup, timeoutMs: 1000 }).extract(
      `http://news.example.com:${port}/start`,
    );
    expect(result?.title).toBe("The Secret Life of Honeybees");
    expect(connected).toEqual(["8.8.8.8", "2606:4700:4700::1111"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(hosts).toEqual([`news.example.com:${port}`, `news.example.com:${port}`]);
    lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    expect(
      await new ReadabilityExtractor({ lookup, maxSizeBytes: 1000 }).extract(
        `http://news.example.com:${port}/bomb`,
      ),
    ).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("HTTPS verifies certificate trust and hostname while preserving SNI", async () => {
  const names: (string | false | null)[] = [];
  const server = createHttpsServer({ key, cert }, (req, res) => {
    names.push((req.socket as import("node:tls").TLSSocket).servername);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const original = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as {
      host?: string;
      lookup?: (
        host: string,
        options: { all: boolean },
        cb: (error: Error | null, address: string, family: number) => void,
      ) => void;
    };
    if (options.host?.endsWith("example.com") && options.lookup) {
      options.lookup(options.host, { all: false }, (err, ip) => {
        if (err) throw err;
        expect(ip).toBe("8.8.8.8");
      });
      Object.assign(options, { host: "127.0.0.1", family: 4, lookup: undefined });
    }
    return Reflect.apply(original, this, args);
  } as typeof Socket.prototype.connect);
  const extractor = new ReadabilityExtractor({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  try {
    expect(await extractor.extract(`https://news.example.com:${port}/`)).toBeNull();
    setDefaultCACertificates([...roots, cert.toString()]);
    expect(await extractor.extract(`https://wrong.example.com:${port}/`)).toBeNull();
    expect((await extractor.extract(`https://news.example.com:${port}/`))?.title).toBe(
      "The Secret Life of Honeybees",
    );
    expect(names).toEqual(["news.example.com"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
