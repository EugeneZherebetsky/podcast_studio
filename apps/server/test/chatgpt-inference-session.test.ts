import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";

it("uses the in-memory plan token for models and inference", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt-inference-"));
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ models: [{ visibility: "list", slug: "m", display_name: "M" }] })
      : new Response(
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n',
        ),
  );
  vi.stubGlobal("fetch", transport);
  try {
    const login = async () => ({
      authorizationUrl: "https://example.test",
      close() {},
      result: Promise.resolve({
        kind: "success" as const,
        subject: "sub",
        clientId: "client",
        accessToken: "secret",
        refreshToken: "refresh",
        idToken: "id",
        expiresIn: 60,
        scopes: [],
        planEnabled: true,
      }),
    });
    const session = await createChatGptSession(dir, login, async () => "revoked" as const);
    await (await session.login("work")).complete();
    expect(await session.models()).toEqual([{ slug: "m", display_name: "M" }]);
    expect(await session.generate("m", "hello")).toBe("ok");
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
    await session.signout();
    await expect(session.models()).rejects.toThrow("plan-enabled");
  } finally {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
