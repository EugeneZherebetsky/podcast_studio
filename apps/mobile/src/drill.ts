type Segment = { startMs: number; endMs: number };
type State = { mode: "off" | "drill" | "loop"; index: number; phase: "playing" | "pausing" | "paused" | "seeking"; repeats: 1 | 2 | 3; completed: number };
export type DrillEvent =
  | { type: "enable"; positionMs: number }
  | { type: "disable" }
  | { type: "loop" | "select"; index: number }
  | { type: "repeat" | "previous" | "next" | "resume" | "seeked" }
  | { type: "repeats"; count: 1 | 2 | 3 }
  | { type: "clock"; positionMs: number; playing: boolean; finished?: boolean };
type Effect = { type: "pause" } | { type: "seek"; positionMs: number; play: boolean } | null;
export const createDrill = (): State => ({ mode: "off", index: -1, phase: "paused", repeats: 1, completed: 0 });

export function transition(state: State, event: DrillEvent, segments: Segment[]): { state: State; effect: Effect } {
  let next = { ...state };
  let effect: Effect = null;
  const seek = (index: number, play: boolean) => {
    if (!segments[index] || segments[index].endMs <= segments[index].startMs) return;
    next = { ...next, index, phase: "seeking", completed: 0 };
    effect = { type: "seek", positionMs: segments[index].startMs, play };
  };
  switch (event.type) {
    case "disable": next = { ...createDrill(), repeats: state.repeats }; break;
    case "repeats": next.repeats = event.count; next.completed = 0; break;
    case "enable": {
      const index = segments.findIndex((s) => s.endMs > event.positionMs && s.endMs > s.startMs);
      if (index >= 0) next = { ...next, mode: "drill", index, phase: "playing", completed: 0 };
      break;
    }
    case "loop": if (segments[event.index]?.endMs > segments[event.index]?.startMs) { next.mode = "loop"; seek(event.index, true); } break;
    case "select": if (state.mode === "loop") next.mode = "off"; seek(event.index, true); break;
    case "repeat": seek(state.index, true); break;
    case "previous": seek(state.index - 1, true); break;
    case "next": seek(state.index + 1, true); break;
    case "resume": if (state.phase === "paused") seek(state.index + 1, true); break;
    case "seeked": next.phase = "playing"; break;
    case "clock": {
      const segment = segments[state.index];
      if (state.phase === "pausing") {
        if (!event.playing) next.phase = "paused";
        break;
      }
      if (state.mode === "drill" && state.phase === "paused" && event.playing) {
        if (segments[state.index + 1]) seek(state.index + 1, true);
        else effect = { type: "pause" };
        break;
      }
      if (state.mode === "off" || state.phase !== "playing" || !segment || (!event.playing && !event.finished)) break;
      if (event.positionMs >= segment.endMs || event.finished) {
        if (state.mode === "loop" || state.completed + 1 < state.repeats) {
          seek(state.index, true);
          next.completed = state.completed + 1;
        } else {
          next.phase = event.playing ? "pausing" : "paused";
          effect = { type: "pause" };
        }
      }
      break;
    }
  }
  return { state: next, effect };
}
