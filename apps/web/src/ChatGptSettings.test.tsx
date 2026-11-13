import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import {
  acknowledgeDisconnect,
  ChatGptDisconnectNotice,
  CHATGPT_SETTINGS_URL,
  type Status,
} from "./ChatGptSettings.tsx";

const base: Status = {
  active: null,
  planEnabled: false,
  expired: false,
  remoteUncertain: true,
  uncertain: [],
  phase: "idle",
};
const render = (status: Status, confirming = false) =>
  renderToString(
    <ChatGptDisconnectNotice
      status={status}
      confirming={confirming}
      busy={false}
      onBegin={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
const disconnectButton = (html: string) =>
  /<button[^>]*>I(&#x27;|&apos;|')ve disconnected Podcast Studio in ChatGPT Settings<\/button>/.exec(
    html,
  )?.[0];

test("warns for each cause and links to ChatGPT Settings in a new tab", () => {
  const stopped = render({
    ...base,
    uncertain: [{ label: "work", cause: "stopped-while-signed-in" }],
  });
  expect(stopped.replaceAll("<!-- -->", "")).toContain(
    "could not confirm that OpenAI ended its access for work.",
  );
  expect(stopped).toContain("This does not mean anyone has used your account");
  expect(stopped).toContain("Podcast Studio stopped while signed in");
  expect(stopped).toContain(`href="${CHATGPT_SETTINGS_URL}"`);
  expect(stopped).toContain('target="_blank"');
  expect(stopped).toContain('rel="noopener noreferrer"');
  const unconfirmed = render({
    ...base,
    uncertain: [{ label: "home", cause: "signout-not-confirmed" }],
  });
  expect(unconfirmed).toContain("Sign-out could not be confirmed");
  expect(unconfirmed).not.toMatch(/revoked|confirmed that/i);
});

test("disables the acknowledgement while signed in or while sign-in is pending", () => {
  const uncertain = [{ label: "work", cause: "signout-not-confirmed" as const }];
  expect(disconnectButton(render({ ...base, uncertain }))).not.toContain("disabled");
  expect(disconnectButton(render({ ...base, uncertain, active: "work" }))).toContain("disabled");
  expect(disconnectButton(render({ ...base, uncertain, phase: "pending" }))).toContain("disabled");
  expect(disconnectButton(render({ ...base, uncertain, phase: "starting" }))).toContain("disabled");
});

test("requires a confirm step before acknowledging, and the warning goes once cleared", async () => {
  const uncertain = [{ label: "work", cause: "signout-not-confirmed" as const }];
  const first = render({ ...base, uncertain });
  expect(first).not.toContain("Yes, I disconnected it");
  const confirming = render({ ...base, uncertain }, true);
  expect(confirming).toContain("Yes, I disconnected it");
  expect(confirming).toContain("cannot check this");
  const post = vi.fn(async () => ({ ...base, remoteUncertain: false, uncertain: [] }));
  const next = await acknowledgeDisconnect(post);
  expect(post).toHaveBeenCalledWith("acknowledge", { disconnectedInChatGptSettings: true });
  expect(render(next)).toBe("");
});

test("keeps credentials and authorization URLs out of web storage, cookies and the URL", () => {
  const source = readFileSync(new URL("./ChatGptSettings.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(
    /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(href|hash|search|assign|replace)/,
  );
});
