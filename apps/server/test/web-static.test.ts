import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import { makeTempDir, removeTempDir } from "./temp-dir.ts";

test("serves only safe built assets without replacing API 404s", async () => {
  const dir = makeTempDir();
  const root = path.join(dir, "dist");
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<html>app</html>");
  writeFileSync(path.join(root, "assets", "app.js"), "export {};");
  writeFileSync(path.join(root, "manifest.webmanifest"), "{}");
  writeFileSync(path.join(dir, "outside.js"), "private");
  // A directory symlink can be created without elevated privileges on Windows.
  symlinkSync(dir, path.join(root, "assets", "escape"), "junction");
  const db = openDatabase(":memory:");
  const app = buildApp({ db, webRoot: root });
  try {
    for (const [url, type] of [
      ["/", "text/html"],
      ["/assets/app.js?x=1", "text/javascript"],
      ["/manifest.webmanifest", "application/manifest+json"],
    ]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect((await app.inject({ method: "HEAD", url: "/assets/app.js" })).statusCode).toBe(200);
    for (const url of [
      "/api/nope",
      "/api",
      "/missing.js",
      "/route",
      "/assets/%2e%2e/outside.js",
      "/assets/%5c..%5coutside.js",
      "/assets/escape/outside.js",
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/", headers: { host: "evil.example" } })).statusCode).toBe(
      403,
    );
  } finally {
    await app.close();
    db.$client.close();
    removeTempDir(dir);
  }
});
