import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

const net = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ connect: net.connect }));
import { preflightSearch, SEARCH_UNREACHABLE } from "../src/search-preflight.ts";

function socket() {
  const result = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  net.connect.mockReturnValue(result);
  return result;
}
afterEach(() => { vi.useRealTimers(); net.connect.mockReset(); });

test("pins localhost and closes a successful probe", async () => {
  const s = socket();
  const probe = preflightSearch("http://localhost:8888");
  expect(net.connect).toHaveBeenCalledWith({ host: "127.0.0.1", port: 8888 });
  s.emit("connect");
  await expect(probe).resolves.toBeUndefined();
  expect(s.destroy).toHaveBeenCalled();
});

test("refusal and timeout return safe guidance and destroy the socket", async () => {
  vi.useFakeTimers();
  const s = socket();
  const probe = preflightSearch("http://[::1]:8888");
  const failure = expect(probe).rejects.toThrow(SEARCH_UNREACHABLE);
  await vi.advanceTimersByTimeAsync(2000);
  await failure;
  expect(s.destroy).toHaveBeenCalled();
  const refused = socket();
  const second = preflightSearch("http://127.0.0.1:8888");
  const failure2 = expect(second).rejects.toThrow(SEARCH_UNREACHABLE);
  refused.emit("error", new Error("sensitive detail"));
  await failure2;
  expect(refused.destroy).toHaveBeenCalled();
});

test("rejects non-loopback addresses without opening a socket", async () => {
  await expect(preflightSearch("http://192.0.2.1:8888")).rejects.toThrow(/loopback/);
  expect(net.connect).not.toHaveBeenCalled();
});
