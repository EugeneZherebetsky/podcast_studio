import { useEffect, useRef, useState } from "react";
import { Button, SafeAreaView, Text } from "react-native";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useLocalSearchParams } from "expo-router";
import type { Episode } from "shared";
import { listOfflineEpisodes } from "../src/offline-files";
import { clampPosition, formatTime } from "../src/position";
import Storage from "expo-sqlite/kv-store";
import { offlinePlayback } from "../src/offline-playback";

function OfflinePlayer({ episode, audioUri }: { episode: Episode; audioUri: string }) {
  const player = useAudioPlayer({ uri: audioUri }, { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [positionReady, setPositionReady] = useState(false);
  const restored = useRef(false);
  const canSave = useRef(true);
  const target = useRef(0);
  const lastSaved = useRef(-1);
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
    <Button title={status.playing ? "Pause" : "Play"} disabled={!ready || !positionReady || !status.isLoaded} onPress={() => {
      if (status.playing) player.pause();
      else { player.setActiveForLockScreen(true, { title: episode.title, artist: episode.generation.voice }); player.play(); }
    }} />
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
