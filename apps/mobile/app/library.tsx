import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, SafeAreaView, Text } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { File } from "expo-file-system";
import { clampPosition, formatTime } from "../src/position";
import { sampleEpisode } from "../src/sample";
import { samplePlayback } from "../src/sample-playback";
import { importUsbEpisode, listOfflineEpisodes } from "../src/offline-files";
import type { Episode } from "shared";

export default function Library() {
  const router = useRouter();
  const [position, setPosition] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [offline, setOffline] = useState<Episode[]>([]);
  const [offlineError, setOfflineError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const importPackage = async () => {
    setImporting(true);
    setImportMessage("");
    try {
      const metadata = await File.pickFileAsync({ mimeTypes: "*/*" });
      if (metadata.canceled) return;
      setImportMessage("Now select audio.m4a from the same trusted package.");
      const audio = await File.pickFileAsync({ mimeTypes: "*/*" });
      if (audio.canceled) { setImportMessage("Import cancelled."); return; }
      const episode = await importUsbEpisode(metadata.result, audio.result);
      setOffline((await listOfflineEpisodes()).map((row) => row.episode));
      setImportMessage(`Imported ${episode.title}.`);
    } catch (error) {
      setImportMessage(`Import failed: ${error instanceof Error ? error.message : "Unable to read package"}`);
    } finally {
      setImporting(false);
    }
  };
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
      <Text>USB import: select episode.json, then audio.m4a from a trusted copied package. Checksums detect corruption, not the source.</Text>
      <Button title="Import USB package" disabled={importing} onPress={importPackage} />
      {importMessage ? <Text accessibilityLiveRegion="polite">{importMessage}</Text> : null}
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
