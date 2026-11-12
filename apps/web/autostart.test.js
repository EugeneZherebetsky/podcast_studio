import { describe, expect, it, vi } from "vitest";
import { manageAutostart } from "../../scripts/autostart.mjs";

describe("Windows autostart", () => {
  it("creates a login task without overwriting an existing one", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "" }));
    manageAutostart("install", {
      run,
      platform: "win32",
      root: "C:\\Example Folder\\app",
      node: "C:\\Program Files\\node.exe",
    });
    expect(run).toHaveBeenCalledOnce();
    const args = run.mock.calls[0][1];
    expect(args).toContain("/CREATE");
    expect(args).toContain("ONLOGON");
    expect(args).not.toContain("/F");
    expect(args[args.indexOf("/TR") + 1]).toContain('"C:\\Program Files\\node.exe"');
  });

  it("removes only a task with the expected action", () => {
    const root = "C:\\Example Folder\\app";
    const node = "C:\\Program Files\\node.exe";
    const run = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `<Task><Actions><Exec><Command>${node}</Command><Arguments>&quot;${root}\\scripts\\autostart-server.mjs&quot;</Arguments></Exec></Actions></Task>`,
      })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    manageAutostart("remove", { run, platform: "win32", root, node });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toContain("/DELETE");
  });

  it("refuses to remove an unrelated task or continue after a scheduler error", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "<Task><Command>other.exe</Command></Task>" }));
    expect(() => manageAutostart("remove", { run, platform: "win32" })).toThrow(/refusing/);
    expect(run).toHaveBeenCalledOnce();
    expect(() =>
      manageAutostart("install", {
        run: () => ({ status: 1, stderr: "already exists" }),
        platform: "win32",
      }),
    ).toThrow(/already exists/);
    expect(() => manageAutostart("install", { run, platform: "linux" })).toThrow(/Windows/);
  });
});
