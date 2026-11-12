import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Button, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Storage from "expo-sqlite/kv-store";
import type { EpisodeSegment, Token } from "shared";
import { segmentAt, tokenParts } from "./transcript";
import { localVocabulary } from "./local-vocabulary";

type TranslationMode = "tap" | "always" | "never";
const settingKey = "transcript-translation-mode-v1";

export function Transcript({ episodeId, segments, positionMs, onSeek, onLoop }: {
  episodeId: string;
  segments: EpisodeSegment[];
  positionMs: number;
  onSeek: (seconds: number) => void;
  onLoop: (index: number) => void;
}) {
  const [mode, setMode] = useState<TranslationMode>(() => {
    try {
      const value = Storage.getItemSync(settingKey);
      return value === "always" || value === "never" ? value : "tap";
    } catch { return "tap"; }
  });
  const [settingError, setSettingError] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<{ token: Token; segment: EpisodeSegment } | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const positions = useRef<Record<number, number>>({});
  const active = segmentAt(segments, positionMs);
  useEffect(() => {
    if (active >= 0 && positions.current[active] !== undefined) {
      scroll.current?.scrollTo({ y: positions.current[active], animated: true });
    }
  }, [active]);
  const changeMode = (next: TranslationMode) => {
    setMode(next);
    try { Storage.setItemSync(settingKey, next); setSettingError(false); }
    catch { setSettingError(true); }
  };
  return <View style={{ flex: 1, gap: 8 }}>
    <Text accessibilityRole="header">Transcript</Text>
    <Text>Translations: {mode === "tap" ? "tap to show" : mode}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {(["tap", "always", "never"] as const).map((value) => <Pressable key={value}
        accessibilityRole="radio" accessibilityState={{ checked: mode === value }}
        onPress={() => changeMode(value)} style={{ padding: 10 }}>
        <Text>{value === "tap" ? "Tap to show" : value === "always" ? "Always show" : "Never show"}</Text>
      </Pressable>)}
    </View>
    {settingError ? <Text accessibilityRole="alert">Could not save translation setting.</Text> : null}
    <ScrollView ref={scroll} accessibilityLabel="Episode transcript">
      {segments.map((segment, index) => <View key={`${segment.id}-${index}`}
        onLayout={(event) => {
          positions.current[index] = event.nativeEvent.layout.y;
          if (index === active) scroll.current?.scrollTo({ y: positions.current[index], animated: false });
        }} style={{ padding: 12, backgroundColor: active === index ? "#dcecff" : "transparent" }}>
        <Text accessibilityRole="button" accessibilityLabel={`${active === index ? "Current sentence. " : ""}${segment.text}. Seek${mode === "tap" && segment.translation ? " and toggle translation" : ""}`}
          onLongPress={() => onLoop(index)}
          onPress={() => {
            onSeek(segment.startMs / 1000);
            if (mode === "tap" && segment.translation) setRevealed((old) => ({ ...old, [segment.id]: !old[segment.id] }));
          }} style={{ fontSize: 18, lineHeight: 30, fontWeight: active === index ? "bold" : "normal" }}>
          {tokenParts(segment.text, segment.tokens ?? []).map((part, partIndex) => part.token
            ? <Text key={partIndex} accessibilityRole="button" accessibilityLabel={`Word ${part.text}, show details`}
                onPress={(event) => { event.stopPropagation(); if (part.token) { setSaveMessage(""); setSelected({ token: part.token, segment }); } }} style={{ textDecorationLine: "underline" }}>{part.text}</Text>
            : <Text key={partIndex}>{part.text}</Text>)}
        </Text>
        <Button title={`Loop sentence ${index + 1}`} onPress={() => onLoop(index)} disabled={segment.endMs <= segment.startMs} />
        {segment.translation && (mode === "always" || (mode === "tap" && revealed[segment.id]))
          ? <Text style={{ marginTop: 6 }}>{segment.translation}</Text> : null}
      </View>)}
      {segments.length === 0 ? <Text>No transcript available.</Text> : null}
    </ScrollView>
    <Modal visible={selected !== null} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#0008" }}>
        <View accessibilityViewIsModal style={{ backgroundColor: "white", padding: 24, maxHeight: "80%", gap: 8 }}>
          <ScrollView>
            <Text accessibilityRole="header" style={{ fontSize: 22 }}>{selected?.token.surface}</Text>
            <Text>Lemma: {selected?.token.lemma}</Text>
            <Text>Part of speech: {selected?.token.pos}</Text>
            <Text>Meaning: {selected?.token.gloss || "Not provided"}</Text>
            <Text accessibilityRole="header">Morphemes</Text>
            {selected?.token.morphemes?.length ? selected.token.morphemes.map((morpheme, index) =>
              <Text key={index}>{morpheme.form}: {morpheme.meaning}</Text>) : <Text>Not provided</Text>}
            <Button title="Save word" disabled={saving || !selected} onPress={async () => {
              if (!selected || saving) return;
              setSaving(true);
              try {
                await (await localVocabulary()).save({ token: selected.token, sentence: selected.segment.text, translation: selected.segment.translation, episodeId, startMs: selected.segment.startMs, endMs: selected.segment.endMs });
                setSaveMessage("Saved on this phone.");
              } catch { setSaveMessage("Could not save word."); }
              finally { setSaving(false); }
            }} />
            {saveMessage ? <Text accessibilityLiveRegion="polite">{saveMessage}</Text> : null}
            <Text>Reporting errors is not available yet.</Text>
          </ScrollView>
          <Button title="Close word details" onPress={() => setSelected(null)} />
        </View>
      </View>
    </Modal>
  </View>;
}
