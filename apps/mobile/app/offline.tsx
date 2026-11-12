import { useEffect, useRef, useState } from "react";
import { Button, SafeAreaView, Text, View } from "react-native";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useLocalSearchParams } from "expo-router";
import type { Episode } from "shared";
import { listOfflineEpisodes } from "../src/offline-files";
import { clampPosition, formatTime } from "../src/position";
import Storage from "expo-sqlite/kv-store";
import { createSeekCheckpoint, offlinePlayback } from "../src/offline-playback";
import { Transcript } from "../src/TranscriptView";
import { SpeedControl } from "../src/SpeedControl";
import { createDrill, transition, type DrillEvent } from "../src/drill";

function OfflinePlayer({ episode, audioUri }: { episode: Episode; audioUri: string }) {
  const player = useAudioPlayer({ uri: audioUri }, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [checkpoint] = useState(() => createSeekCheckpoint(offlinePlayback(Storage, episode.id), () => setError("Could not save position.")));
  const [positionReady, setPositionReady] = useState(false);
  const restored = useRef(false);
  const canSave = useRef(true);
  const target = useRef(0);
  const lastSaved = useRef(-1);
  const [drill, setDrill] = useState(createDrill);
  const drillRef = useRef(drill);
  const seekGeneration = useRef(0);
  const dispatch = (event: DrillEvent) => {
    const result = transition(drillRef.current, event, episode.segments);
    drillRef.current = result.state;
    setDrill(result.state);
    if (event.type === "disable" || event.type === "enable") seekGeneration.current++;
    if (result.effect?.type === "pause") player.pause();
    if (result.effect?.type === "seek") {
      const effect = result.effect;
      const generation = ++seekGeneration.current;
      player.pause();
      const seconds = clampPosition(effect.positionMs / 1000, status.duration);
      checkpoint.seek(seconds, () => player.seekTo(seconds), canSave.current).then(() => {
        if (generation !== seekGeneration.current) return;
        target.current = seconds;
        const next = transition(drillRef.current, { type: "seeked" }, episode.segments).state;
        drillRef.current = next; setDrill(next);
        if (effect.play) { player.setActiveForLockScreen(true, { title: episode.title, artist: episode.generation.voice }); player.play(); }
      }).catch(() => { if (generation === seekGeneration.current) { dispatch({ type: "disable" }); setError("Could not seek."); } });
    }
  };
  useEffect(() => () => { seekGeneration.current++; }, []);
  useEffect(() => {
    if (positionReady && status.isLoaded) dispatch({ type: "clock", positionMs: status.currentTime * 1000, playing: status.playing, finished: status.didJustFinish });
  // Playback status is the player clock; commands are serialized by seekGeneration.
  }, [positionReady, status.currentTime, status.playing, status.isLoaded, status.didJustFinish]);
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "doNotMix" })
      .then(() => setReady(true)).catch(() => setError("Could not configure background audio."));
  }, []);
  useEffect(() => {
    if (!status.isLoaded || restored.current || status.duration <= 0) return;
    restored.current = true;
    try {
      target.current = clampPosition(offlinePlayback(Storage, episode.id).position(), status.duration);
      player.seekTo(target.current).then(() => setPositionReady(true)).catch(() => {
        canSave.current = false; setError("Could not restore position."); setPositionReady(true);
      });
    } catch {
      canSave.current = false; setError("Could not read saved position."); setPositionReady(true);
    }
  }, [episode.id, player, status.isLoaded, status.duration]);
  useEffect(() => {
    if (!positionReady || !status.isLoaded || !canSave.current) return;
    if (!checkpoint.acceptClock(status.currentTime, status.didJustFinish)) return;
    if (lastSaved.current === -1 && Math.abs(status.currentTime - target.current) > 1) return;
    const second = Math.floor(status.currentTime);
    if (!status.didJustFinish && (second === lastSaved.current || (status.playing && second % 5 !== 0))) return;
    try {
      offlinePlayback(Storage, episode.id).record(clampPosition(status.currentTime, status.duration), status.didJustFinish);
      lastSaved.current = second;
    } catch { setError("Could not save position."); }
  }, [episode.id, positionReady, status.currentTime, status.duration, status.playing, status.isLoaded, status.didJustFinish]);
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 16 }}>
    <Text accessibilityRole="header">{episode.title}</Text>
    <Text>Available offline</Text>
    <Text>{formatTime(status.currentTime)} / {formatTime(status.duration)}</Text>
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    <Button title={status.playing ? "Pause" : "Play"} disabled={!ready || !positionReady || !status.isLoaded || drill.phase === "seeking" || drill.phase === "pausing" || (drill.mode === "drill" && drill.phase === "paused" && drill.index === episode.segments.length - 1)} onPress={() => {
      if (status.playing) player.pause();
      else if (drill.mode === "drill" && drill.phase === "paused" && drill.index + 1 < episode.segments.length) dispatch({ type: "resume" });
      else { player.setActiveForLockScreen(true, { title: episode.title, artist: episode.generation.voice }); player.play(); }
    }} />
    <SpeedControl player={player} mode={episode.mode} disabled={!status.isLoaded} />
    {episode.segments.length ? <View>
      <Text>Sentence mode: {drill.mode === "loop" ? `looping sentence ${drill.index + 1}` : drill.mode}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Button title={drill.mode === "drill" ? "Turn drill off" : "Turn drill on"} disabled={!positionReady || !status.isLoaded} onPress={() => dispatch(drill.mode === "drill" ? { type: "disable" } : { type: "enable", positionMs: status.currentTime * 1000 })} />
        {drill.mode === "loop" ? <Button title="Dismiss loop" onPress={() => dispatch({ type: "disable" })} /> : null}
        <Button title="Previous" disabled={drill.mode === "off" || drill.index <= 0} onPress={() => dispatch({ type: "previous" })} />
        <Button title="Repeat" disabled={drill.mode === "off"} onPress={() => dispatch({ type: "repeat" })} />
        <Button title="Next" disabled={drill.mode === "off" || drill.index >= episode.segments.length - 1} onPress={() => dispatch({ type: "next" })} />
        <Button title={`Plays: ${drill.repeats}×`} onPress={() => dispatch({ type: "repeats", count: drill.repeats === 3 ? 1 : drill.repeats === 1 ? 2 : 3 })} />
      </View>
    </View> : null}
    {positionReady && status.isLoaded ? <Transcript episodeId={episode.id} segments={episode.segments} positionMs={status.currentTime * 1000}
      onLoop={(index) => dispatch({ type: "loop", index })}
      onSeek={(seconds) => {
        if (drillRef.current.mode !== "off") dispatch({ type: "select", index: episode.segments.findIndex((s) => s.startMs === seconds * 1000) });
        else {
          const destination = clampPosition(seconds, status.duration);
          checkpoint.seek(destination, () => player.seekTo(destination), canSave.current)
            .then((current) => { if (current) target.current = destination; })
            .catch(() => setError("Could not seek."));
        }
      }} /> : null}
  </SafeAreaView>;
}

export default function Offline() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [row, setRow] = useState<{ episode: Episode; audioUri: string } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    listOfflineEpisodes().then((rows) => {
      const found = rows.find((item) => item.episode.id === id);
      if (active) { setRow(found ?? null); setError(!found); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id]);
  if (row) return <OfflinePlayer episode={row.episode} audioUri={row.audioUri} />;
  return <Text accessibilityRole={error ? "alert" : undefined}>{error ? "Could not verify this offline episode." : "Loading offline episode…"}</Text>;
}
