import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import Storage from "expo-sqlite/kv-store";
import type { AudioPlayer } from "expo-audio";
import { readSpeed, stepSpeed } from "./speed";

export function SpeedControl({ player, mode, disabled }: { player: AudioPlayer; mode: string; disabled: boolean }) {
  const key = `playback-speed-v1-${mode}`;
  const [rate, setRate] = useState(() => {
    try { return readSpeed(Storage.getItemSync(key)); } catch { return 1; }
  });
  const [error, setError] = useState(false);
  useEffect(() => { player.shouldCorrectPitch = true; player.setPlaybackRate(rate); }, [player, rate]);
  const change = (direction: -1 | 1) => {
    const next = stepSpeed(rate, direction);
    setRate(next);
    try { Storage.setItemSync(key, String(next)); setError(false); } catch { setError(true); }
  };
  return <View>
    <Text>Speed: {rate.toFixed(2)}×</Text>
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button title="Slower by 0.05" disabled={disabled || rate <= 0.5} onPress={() => change(-1)} />
      <Button title="Faster by 0.05" disabled={disabled || rate >= 1.5} onPress={() => change(1)} />
    </View>
    {error ? <Text accessibilityRole="alert">Could not save speed.</Text> : null}
  </View>;
}
