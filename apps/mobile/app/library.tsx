import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, SafeAreaView, Text } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { clampPosition, formatTime } from "../src/position";
import { sampleEpisode } from "../src/sample";
import { samplePlayback } from "../src/sample-playback";
import { listOfflineEpisodes } from "../src/offline-files";
import type { Episode } from "shared";

export default function Library() {
  const router = useRouter();
  const [position, setPosition] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [offline, setOffline] = useState<Episode[]>([]);
  const [offlineError, setOfflineError] = useState(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    listOfflineEpisodes().then((rows) => {
      if (active) { setOffline(rows.map((row) => row.episode)); setOfflineError(false); }
    }).catch(() => { if (active) setOfflineError(true); });
    try {
      const saved = samplePlayback(Storage, sampleEpisode.id).position();
      setPosition(clampPosition(saved, sampleEpisode.durationMs / 1000));
      setError(false);
    } catch {
      setError(true);
    }
    return () => { active = false; };
  }, []));
  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text accessibilityRole="header" style={{ fontSize: 24 }}>
        Library
      </Text>
      <Text>Server pairing and sync are not available yet.</Text>
      <Text>{sampleEpisode.title} • bundled • available offline</Text>
      {error ? <Text accessibilityRole="alert">Could not read saved position.</Text> : null}
      {position !== null && !error ? <Text>Saved position: {formatTime(position)}</Text> : null}
      <Button title="Open sample player" onPress={() => router.navigate("/")} />
      {offlineError ? <Text accessibilityRole="alert">Could not verify the offline library.</Text> : null}
      {offline.map((episode, index) => (
        <Button key={`${episode.id}-${index}`} title={`${episode.title} • offline`} onPress={() => router.push({ pathname: "/offline", params: { id: episode.id } })} />
      ))}
    </SafeAreaView>
  );
}
