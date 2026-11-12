import { expect, it } from "vitest";
import { syncPlayback } from "./playback-sync";

it("sends pending playback and acknowledges only the snapshot sent", async () => {
  const first = {
    episodeId: "episode",
    positionMs: 1000,
    finished: false,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const newer = { ...first, positionMs: 2000, updatedAt: "2026-01-02T00:00:00Z" };
  let pending = [first];
  await syncPlayback(
    {
      pending: () => pending,
      acknowledge: (sent) => {
        pending = pending.filter(
          (row) => !sent.some((item) => JSON.stringify(item) === JSON.stringify(row)),
        );
      },
    },
    async (body) => {
      expect(body).toEqual({ positions: [first] });
      pending = [newer];
      return { ok: true };
    },
  );
  expect(pending).toEqual([newer]);
});

it("keeps pending positions after transport failure or invalid response", async () => {
  const position = {
    episodeId: "episode",
    positionMs: 1,
    finished: false,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let pending = [position];
  const queue = {
    pending: () => pending,
    acknowledge: () => {
      pending = [];
    },
  };
  await expect(
    syncPlayback(queue, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  await expect(syncPlayback(queue, async () => ({ ok: false }))).rejects.toThrow();
  expect(pending).toEqual([position]);
});

it("does not contact the server for an empty queue", async () => {
  let called = false;
  await syncPlayback(
    {
      pending: () => [],
      acknowledge: () => {
        throw new Error("unexpected acknowledgement");
      },
    },
    async () => {
      called = true;
    },
  );
  expect(called).toBe(false);
});
