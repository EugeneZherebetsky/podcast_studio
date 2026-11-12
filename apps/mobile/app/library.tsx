import { useRouter } from "expo-router";
import { Button, SafeAreaView, Text } from "react-native";
import { sampleEpisode } from "../src/sample";

export default function Library() {
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text accessibilityRole="header" style={{ fontSize: 24 }}>
        Library
      </Text>
      <Text>Server pairing and sync are not available yet.</Text>
      <Text>{sampleEpisode.title} • bundled • available offline</Text>
      <Button title="Open sample player" onPress={() => router.navigate("/")} />
    </SafeAreaView>
  );
}
