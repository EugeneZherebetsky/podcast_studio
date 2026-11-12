import { describe, expect, it } from "vitest";
import { createDrill, transition } from "./drill";

const segments = [{ startMs: 0, endMs: 1000 }, { startMs: 1400, endMs: 2200 }];

describe("sentence drill with a fake player clock", () => {
  it("pauses a ticking player in silence, then resumes the next sentence", () => {
    let state = transition(createDrill(), { type: "enable", positionMs: 0 }, segments).state;
    const player = { positionMs: 0, playing: true };
    const tick = (ms: number) => {
      if (player.playing) player.positionMs += ms;
      const result = transition(state, { type: "clock", ...player }, segments);
      state = result.state;
      if (result.effect?.type === "pause") player.playing = false;
      if (result.effect?.type === "seek") { player.positionMs = result.effect.positionMs; player.playing = result.effect.play; }
    };
    tick(950); expect(player.playing).toBe(true);
    tick(100); expect(player).toEqual({ positionMs: 1050, playing: false });
    tick(0);
    const resume = transition(state, { type: "resume" }, segments);
    expect(resume.effect).toEqual({ type: "seek", positionMs: 1400, play: true });
  });
  it("pauses at the first sentence boundary even when the clock skips into silence", () => {
    let state = createDrill();
    state = transition(state, { type: "enable", positionMs: 100 }, segments).state;
    state = transition(state, { type: "clock", positionMs: 900, playing: true }, segments).state;
    const result = transition(state, { type: "clock", positionMs: 1100, playing: true }, segments);
    expect(result.effect).toEqual({ type: "pause" });
    expect(result.state).toMatchObject({ mode: "drill", phase: "pausing", index: 0 });
  });
  it("repeats twice before pausing and advances on resume", () => {
    let state = transition(createDrill(), { type: "enable", positionMs: 0 }, segments).state;
    state = transition(state, { type: "repeats", count: 2 }, segments).state;
    const first = transition(state, { type: "clock", positionMs: 1010, playing: true }, segments);
    expect(first.effect).toEqual({ type: "seek", positionMs: 0, play: true });
    expect(transition(first.state, { type: "clock", positionMs: 1200, playing: true }, segments).effect).toBeNull();
    state = transition(first.state, { type: "seeked" }, segments).state;
    const second = transition(state, { type: "clock", positionMs: 1001, playing: true }, segments);
    expect(second.effect).toEqual({ type: "pause" });
    expect(transition(second.state, { type: "clock", positionMs: 1100, playing: true }, segments).effect).toBeNull();
    const paused = transition(second.state, { type: "clock", positionMs: 1100, playing: false }, segments).state;
    expect(transition(paused, { type: "resume" }, segments).effect).toEqual({ type: "seek", positionMs: 1400, play: true });
    expect(transition(paused, { type: "clock", positionMs: 1100, playing: true }, segments).effect).toEqual({ type: "seek", positionMs: 1400, play: true });
  });
  it("loops through end of media and stops after dismissal", () => {
    const loop = transition(createDrill(), { type: "loop", index: 1 }, segments);
    expect(loop.effect).toEqual({ type: "seek", positionMs: 1400, play: true });
    const playing = transition(loop.state, { type: "seeked" }, segments).state;
    const end = transition(playing, { type: "clock", positionMs: 0, playing: false, finished: true }, segments);
    expect(end.effect).toEqual({ type: "seek", positionMs: 1400, play: true });
    const off = transition(end.state, { type: "disable" }, segments).state;
    expect(transition(off, { type: "clock", positionMs: 2300, playing: true }, segments).effect).toBeNull();
  });
  it("ignores a manual pause and navigates without leaving the transcript", () => {
    const state = transition(createDrill(), { type: "enable", positionMs: 200 }, segments).state;
    expect(transition(state, { type: "clock", positionMs: 1100, playing: false }, segments).effect).toBeNull();
    expect(transition(state, { type: "previous" }, segments).effect).toBeNull();
    expect(transition(state, { type: "repeat" }, segments).effect).toEqual({ type: "seek", positionMs: 0, play: true });
    expect(transition(state, { type: "next" }, segments).effect).toEqual({ type: "seek", positionMs: 1400, play: true });
  });
});
