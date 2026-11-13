import { createInterface } from "node:readline/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { generatePodcastScript } from "./chatgpt-script.ts";
import { loadConfig } from "../config.ts";
import { createChatGptSession } from "../providers/llm/chatgpt-session.ts";

const session = await createChatGptSession(path.join(loadConfig().DATA_DIR, "chatgpt"));
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: !!process.stdin.isTTY,
});
terminal.on("close", () => {
  void session.shutdown();
});
terminal.on("SIGINT", () => terminal.close());
console.log(
  "ChatGPT local session. Commands: login <label>, status, models, ask <model> <prompt>, script <model> <research.json>, signout, quit",
);
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
    } else if (
      (command === "models" && !label) ||
      ((command === "ask" || command === "script") && label && extra)
    ) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      terminal.once("SIGINT", cancel);
      try {
        if (command === "models")
          console.log(JSON.stringify(await session.models(controller.signal)));
        else if (command === "script") {
          const file = line.trim().replace(/^script\s+\S+\s+/, "");
          const input = JSON.parse(await readFile(file, "utf8")) as unknown;
          console.log(
            JSON.stringify(
              await generatePodcastScript(session, label!, input, controller.signal),
              null,
              2,
            ),
          );
        } else
          console.log(
            await session.generate(
              label!,
              line.trim().replace(/^ask\s+\S+\s+/, ""),
              controller.signal,
            ),
          );
      } finally {
        terminal.removeListener("SIGINT", cancel);
      }
    } else if (command === "signout" && !label) {
      console.log(
        (await session.signout())
          ? "Signed out."
          : "Signed out locally; remote revocation not confirmed. Disconnect the app in ChatGPT Settings.",
      );
    } else if (command === "quit" && !label) {
      break;
    } else
      console.log(
        "Commands: login <label>, status, models, ask <model> <prompt>, script <model> <research.json>, signout, quit",
      );
  } catch {
    console.error(
      command === "script"
        ? "Script failed or was cancelled: check research, citations, word count, sign-in, model access and structured-output support. No draft was accepted."
        : "Command failed or was cancelled. Check sign-in, plan access, model, and connection.",
    );
  }
}
terminal.close();
// Shutdown attempts revocation once; anything unconfirmed stays recorded for Settings.
await session.shutdown();
if (session.status().remoteUncertain)
  console.log(
    "Remote sign-out not confirmed. Disconnect Podcast Studio in ChatGPT Settings, then confirm in Podcast Studio Settings.",
  );
