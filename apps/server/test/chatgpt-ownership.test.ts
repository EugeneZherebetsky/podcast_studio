import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createChatGptSession } from "../src/providers/llm/chatgpt-session.ts";

it("does not acknowledge a grant owned by another live session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ownership-"));
  try {
    const start = async () => ({
      authorizationUrl: "https://example.test",
      close() {},
      result: Promise.resolve({
        kind: "success" as const,
        subject: "sub",
        clientId: "client",
        accessToken: "access",
        idToken: "id",
        expiresIn: 60,
        scopes: [],
        planEnabled: false,
      }),
    });
    const owner = await createChatGptSession(dir, start, async () => "refused");
    await (await owner.login("work")).complete();
    const other = await createChatGptSession(dir);
    await other.acknowledgeRemoteDisconnect();
    expect(
      JSON.parse(await readFile(path.join(dir, "chatgpt-grants.json"), "utf8")).grants,
    ).toHaveLength(1);
    await owner.signout();
    await other.acknowledgeRemoteDisconnect();
    expect(
      JSON.parse(await readFile(path.join(dir, "chatgpt-grants.json"), "utf8")).grants,
    ).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves concurrent live owners and releases ownership after abrupt exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ownership-process-"));
  const children = ["first", "second"].map((label) =>
    fork(path.join(import.meta.dirname, "fixtures", "chatgpt-owner.ts"), [dir, label], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );
  const exits = children.map(
    (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
  );
  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("message", () => resolve());
            child.once("error", reject);
            child.once("exit", (code) => reject(new Error(`owner exited: ${code}`)));
          }),
      ),
    );
    const observer = await createChatGptSession(dir);
    expect(observer.status().uncertain).toHaveLength(2);
    await observer.acknowledgeRemoteDisconnect();
    expect(observer.status().uncertain).toHaveLength(2);
    children[0]!.kill("SIGKILL");
    await exits[0];
    expect(observer.status().uncertain).toHaveLength(2);
    await observer.acknowledgeRemoteDisconnect();
    expect(observer.status().uncertain).toMatchObject([{ label: "second" }]);
    children[1]!.kill("SIGKILL");
    await exits[1];
    await observer.acknowledgeRemoteDisconnect();
    expect(observer.status().remoteUncertain).toBe(false);
  } finally {
    children.forEach((child) => child.kill("SIGKILL"));
    await Promise.all(exits);
    await rm(dir, { recursive: true, force: true });
  }
});

it("fails closed for a legacy directory lock and non-busy lock errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ownership-errors-"));
  try {
    await mkdir(path.join(dir, "chatgpt-registration.lock"));
    await expect(createChatGptSession(dir)).rejects.toThrow(/Stop all old server and CLI/);
    await rm(path.join(dir, "chatgpt-registration.lock"), { recursive: true });
    const session = await createChatGptSession(dir);
    const id = randomUUID();
    await writeFile(
      path.join(dir, "chatgpt-grants.json"),
      JSON.stringify({
        grants: [{ id, label: "work", clientId: "client", state: "grant-may-exist", at: 1 }],
      }),
    );
    await mkdir(path.join(dir, `chatgpt-grant-${id}.sqlite`));
    await expect(session.acknowledgeRemoteDisconnect()).rejects.toThrow();
    expect(session.status().remoteUncertain).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
