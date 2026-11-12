import { useEffect, useRef, useState } from "react";
import { Button, SafeAreaView, Text, View } from "react-native";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import Storage from "expo-sqlite/kv-store";
import { clampPosition, formatTime } from "../src/position";

// Metro requires a static require for bundled media.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const source = require("../assets/sample.mp3");
const key = "sample-position-seconds";

export default function Player() {
  const player = useAudioPlayer(source, { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const restored = useRef(false);
  const lastSaved = useRef(-1);
  const target = useRef(0);
  const [ready, setReady] = useState(false);
  const [positionReady, setPositionReady] = useState(false);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(1);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    })
      .then(() => setReady(true))
      .catch(() => setError("Could not configure background audio."));
  }, []);

  useEffect(() => {
    if (!status.isLoaded || restored.current || status.duration <= 0) return;
    restored.current = true;
    try {
      const saved = Number(Storage.getItemSync(key) ?? 0);
      target.current = clampPosition(saved, status.duration);
      player
        .seekTo(target.current)
        .then(() => setPositionReady(true))
        .catch(() => setError("Could not restore position."));
    } catch {
      setError("Could not read saved position.");
    }
  }, [player, status.isLoaded, status.duration]);

  useEffect(() => {
    if (!positionReady || !status.isLoaded) return;
    if (lastSaved.current === -1 && Math.abs(status.currentTime - target.current) > 1) return;
    const second = Math.floor(status.currentTime);
    if (second === lastSaved.current || (status.playing && second % 5 !== 0)) return;
    try {
      Storage.setItemSync(key, String(status.didJustFinish ? 0 : status.currentTime));
      lastSaved.current = second;
    } catch {
      setError("Could not save position.");
    }
  }, [positionReady, status.currentTime, status.playing, status.isLoaded, status.didJustFinish]);

  const seek = (seconds: number) => {
    player
      .seekTo(clampPosition(status.currentTime + seconds, status.duration))
      .catch(() => setError("Could not seek."));
  };
  const toggle = () => {
    if (status.playing) player.pause();
    else {
      player.setActiveForLockScreen(true, {
        title: "The Mouth",
        artist: "John Poole Sandlands; read by Meliora Dockery",
      });
      player.play();
    }
  };
  const changeRate = () => {
    const next =
      rate === 0.5 ? 0.75 : rate === 0.75 ? 1 : rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : 0.5;
    player.shouldCorrectPitch = true;
    player.playbackRate = next;
    setRate(next);
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 24, justifyContent: "center", gap: 16 }}>
      <Text accessibilityRole="header" style={{ fontSize: 24 }}>
        The Mouth
      </Text>
      <Text>LibriVox sample • available offline</Text>
      <Text>
        {formatTime(status.currentTime)} / {formatTime(status.duration)}
      </Text>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Button title="Back 15s" onPress={() => seek(-15)} disabled={!status.isLoaded} />
        <Button
          title={status.playing ? "Pause" : "Play"}
          onPress={toggle}
          disabled={!ready || !positionReady || !status.isLoaded}
        />
        <Button title="Forward 30s" onPress={() => seek(30)} disabled={!status.isLoaded} />
      </View>
      <Button title={`Speed ${rate}×`} onPress={changeRate} disabled={!status.isLoaded} />
    </SafeAreaView>
  );
}
