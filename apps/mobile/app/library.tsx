import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, SafeAreaView, Text } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { clampPosition, formatTime } from "../src/position";
import { sampleEpisode } from "../src/sample";
import { samplePlayback } from "../src/sample-playback";

export default function Library() {
  const router = useRouter();
  const [position, setPosition] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useFocusEffect(useCallback(() => {
    try {
      const saved = samplePlayback(Storage, sampleEpisode.id).position();
      setPosition(clampPosition(saved, sampleEpisode.durationMs / 1000));
      setError(false);
    } catch {
      setError(true);
    }
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
    </SafeAreaView>
  );
}
