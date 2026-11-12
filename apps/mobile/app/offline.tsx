import { useEffect, useState } from "react";
import { Button, SafeAreaView, Text } from "react-native";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useLocalSearchParams } from "expo-router";
import type { Episode } from "shared";
import { listOfflineEpisodes } from "../src/offline-files";
import { formatTime } from "../src/position";

function OfflinePlayer({ episode, audioUri }: { episode: Episode; audioUri: string }) {
  const player = useAudioPlayer({ uri: audioUri }, { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "doNotMix" })
      .then(() => setReady(true)).catch(() => setError(true));
  }, []);
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 16 }}>
    <Text accessibilityRole="header">{episode.title}</Text>
    <Text>Available offline</Text>
    <Text>{formatTime(status.currentTime)} / {formatTime(status.duration)}</Text>
    {error ? <Text accessibilityRole="alert">Could not configure background audio.</Text> : null}
    <Button title={status.playing ? "Pause" : "Play"} disabled={!ready || !status.isLoaded} onPress={() => {
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
