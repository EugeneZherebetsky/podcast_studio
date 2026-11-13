import { createChatGptSession } from "../../src/providers/llm/chatgpt-session.ts";

const [dir, label] = process.argv.slice(2);
const session = await createChatGptSession(dir!, async () => ({
  authorizationUrl: "https://example.test",
  close() {},
  result: Promise.resolve({
    kind: "success" as const,
    subject: "sub",
    clientId: "client",
    accessToken: "test",
    idToken: "test",
    expiresIn: 60,
    scopes: [],
    planEnabled: false,
  }),
}));
await (await session.login(label!)).complete();
process.send?.("ready");
setInterval(() => {}, 1000);
