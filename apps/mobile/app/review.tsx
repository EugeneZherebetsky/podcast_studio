import { useCallback, useEffect, useRef, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Rating, type Grade } from "ts-fsrs";
import { localVocabulary } from "../src/local-vocabulary";
import { listOfflineEpisodes } from "../src/offline-files";
import type { ReviewWord } from "../src/vocabulary";

function SentenceAudio({ uri, startMs, endMs }: { uri: string; startMs: number; endMs: number }) {
  const player = useAudioPlayer({ uri }, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const started = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current && status.playing && status.currentTime * 1000 >= endMs) {
      started.current = false;
      player.pause();
    }
  }, [status.currentTime, status.playing, endMs, player]);
  return <View>
    <Button title="Play sentence" disabled={!status.isLoaded || endMs <= startMs} onPress={async () => {
      try {
        started.current = false;
        player.pause();
        await setAudioModeAsync({ playsInSilentMode: true });
        await player.seekTo(startMs / 1000);
        started.current = true;
        player.play();
        setError("");
      } catch { setError("Could not play sentence audio."); }
    }} />
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
  </View>;
}

export default function Review() {
  const [queue, setQueue] = useState<ReviewWord[]>([]);
  const [progress, setProgress] = useState<{ due: number; learning: number; known: number; reviewed: number; streak: number } | null>(null);
  const [audio, setAudio] = useState<Record<string, string>>({});
  const [audioError, setAudioError] = useState(false);
  const [audioLoading, setAudioLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const ratingInFlight = useRef(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const store = await localVocabulary();
    const [cards, counts] = await Promise.all([store.due(), store.progress()]);
    setQueue(cards);
    setProgress(counts);
    setRevealed(false);
  }, []);
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    localVocabulary().then(async (store) => Promise.all([store.due(), store.progress()])).then(([cards, counts]) => {
      if (!active) return;
      setQueue(cards);
      setProgress(counts);
      setRevealed(false); setError("");
    }).catch(() => { if (active) setError("Could not load local review cards."); })
      .finally(() => { if (active) setLoading(false); });
    setAudio({});
    setAudioLoading(true);
    listOfflineEpisodes().then((episodes) => {
      if (active) { setAudio(Object.fromEntries(episodes.map((item) => [item.episode.id, item.audioUri]))); setAudioError(false); }
    }).catch(() => { if (active) setAudioError(true); }).finally(() => { if (active) setAudioLoading(false); });
    return () => { active = false; };
  }, []));
  const card = queue[0];
  const rate = async (rating: Grade) => {
    if (!card || ratingInFlight.current) return;
    ratingInFlight.current = true;
    setBusy(true);
    try {
      await (await localVocabulary()).rate(card.id, rating);
      setQueue([]);
      try { await refresh(); setError(""); }
      catch { setError("Review saved, but the queue could not be reloaded. Reopen review to try again."); }
    } catch { setError("Could not save review. Please try again."); }
    finally { ratingInFlight.current = false; setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 16 }}>
    <Text accessibilityRole="header" style={{ fontSize: 24 }}>Vocabulary review</Text>
    <Text>Stored only on this phone. Up to 10 new words per day.</Text>
    {progress ? <Text>Due now: {progress.due} · Learning: {progress.learning} · Known (FSRS review): {progress.known} · Reviewed today: {progress.reviewed} · Review streak: {progress.streak} days (tracked from this update)</Text> : null}
    {audioError ? <Text accessibilityRole="alert">Could not load offline audio. You can still review text.</Text> : null}
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    {loading ? <Text>Loading…</Text> : card ? <ScrollView>
      <Text accessibilityRole="header" style={{ fontSize: 22 }}>{card.token.lemma}</Text>
      {audioLoading ? <Text>Checking offline audio…</Text> : audio[card.episodeId] ? <SentenceAudio key={card.id} uri={audio[card.episodeId]} startMs={card.startMs} endMs={card.endMs} /> : !audioError ? <Text>Original audio is unavailable on this phone.</Text> : null}
      {!revealed ? <Button title="Show answer" onPress={() => setRevealed(true)} /> : <View style={{ gap: 8 }}>
        <Text>Meaning: {card.token.gloss}</Text>
        <Text>{card.sentence}</Text>
        {card.translation ? <Text>{card.translation}</Text> : null}
        {card.token.morphemes?.map((part, i) => <Text key={i}>{part.form}: {part.meaning}</Text>)}
        {([['Again', Rating.Again], ['Hard', Rating.Hard], ['Good', Rating.Good], ['Easy', Rating.Easy]] as const).map(([label, rating]) =>
          <Button key={rating} title={label} disabled={busy} onPress={() => { void rate(rating); }} />)}
      </View>}
    </ScrollView> : !error ? <View><Text>No cards due now.</Text><Button title="Check again" onPress={() => { void refresh().catch(() => setError("Could not load review cards.")); }} /></View> : null}
  </SafeAreaView>;
}
