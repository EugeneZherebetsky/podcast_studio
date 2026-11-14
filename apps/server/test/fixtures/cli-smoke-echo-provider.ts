globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ title: "synthetic-smoke-canary", url: "https://example.invalid/synthetic-smoke-canary", content: "test" }] }), { status: 200, headers: { "content-type": "application/json" } });
export {};
await import("../../src/cli/smoke.ts");
