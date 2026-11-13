import { createInterface } from "node:readline/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { createChatGptSession } from "../providers/llm/chatgpt-session.ts";

const session = await createChatGptSession(path.join(loadConfig().DATA_DIR, "chatgpt"));
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: !!process.stdin.isTTY,
});
console.log("ChatGPT local session. Commands: login <label>, status, signout, quit");
console.log(
  "Sign-in opens no browser automatically. Tokens stay in this process and are lost on exit.",
);
for await (const line of terminal) {
  const [command, label, extra] = line.trim().split(/\s+/);
  try {
    if (command === "login" && label && !extra) {
      const attempt = await session.login(label);
      console.log(
        `Continue with ChatGPT: open this URL in your browser:\n${attempt.authorizationUrl}`,
      );
      console.log((await attempt.complete()) ? "Signed in." : "Authorization denied.");
    } else if (command === "status" && !label) {
      console.log(JSON.stringify(session.status()));
    } else if (command === "signout" && !label) {
      console.log(
        (await session.signout())
          ? "Signed out."
          : "Signed out locally; remote revocation not confirmed. Disconnect the app in ChatGPT Settings.",
      );
    } else if (command === "quit" && !label) {
      break;
    } else console.log("Commands: login <label>, status, signout, quit");
  } catch {
    console.error("Command failed. Check the account label or retry sign-in.");
  }
}
if (session.status().active)
  console.log(
    "Session cleared locally on exit; remote revocation not confirmed. Use signout before quitting or disconnect in ChatGPT Settings.",
  );
terminal.close();
