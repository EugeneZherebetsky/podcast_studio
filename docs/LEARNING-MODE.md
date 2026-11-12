# Hungarian learning mode

Target learner: adult beginner, CEFR A1–A2, explanations in `NATIVE_LANG` (default English). The target language is a config value (`TARGET_LANG=hu`); only Hungarian is designed for and tested.

## 1. Episode modes

### `graded` — whole episode in simple Hungarian

- Content comes from the same research pipeline, retold at the learner's level.
- Constraints given to the script model:
  - A1: sentences ≤ 8 words, present tense, definite/indefinite conjugation only in common verbs, the most frequent cases (‑t, ‑ban/‑ben, ‑ba/‑be, ‑ból/‑ből, ‑on/‑en/‑ön, ‑val/‑vel, ‑nak/‑nek).
  - A2: sentences ≤ 12 words, past tense, possessive suffixes, common verbal prefixes, simple subordinate clauses with *hogy*, *mert*, *amikor*.
  - Proper nouns and international words are free. Numbers are written as words (TTS reads them and the learner sees them).
  - 6–10 **target words** per episode: each appears at least 3 times, first time in a sentence whose meaning is clear from context.
- One sentence per segment, `rate` 0.85 (A1) or 0.95 (A2), `pauseAfterMs` 600.
- Structure: 2-sentence intro in `NATIVE_LANG` stating the topic and the target words → Hungarian body → recap of target words (word, pause, short example sentence).
- Target length: minutes × 90 Hungarian words.

### `bilingual` — teacher format

For each key sentence, four segments:

1. Hungarian, slow (`rate` 0.8), `speaker: host`.
2. Pause 1200 ms (time to guess).
3. `speaker: teacher`, `lang: NATIVE_LANG`: meaning plus one short note on a word or ending. Maximum two sentences.
4. Hungarian again at `rate` 1.0, `repeatOf` set to segment 1.

Use two distinct voices. 12–20 key sentences per 10 minutes. The story across the Hungarian sentences must still be coherent and about the researched topic.

### `standard` in Hungarian

Allowed (native-level podcast with transcript and tap-to-translate) but not a focus for a beginner.

## 2. Per-sentence learning data (generated on the server)

Every Hungarian segment in learning modes carries:

- `translation`: natural, not word-for-word.
- `tokens[]`: for each word, `surface`, `lemma`, `pos`, `gloss` (meaning **in this sentence**), and `morphemes[]` splitting stem and suffixes with a meaning each. Hungarian is agglutinative; showing *házamban → ház (house) + ‑am (my) + ‑ban (in)* is the single most useful thing the app can do for a beginner.
- Tokens must concatenate (with whitespace and punctuation) back to `text` exactly. The server validates this and retries the segment if not.

Generate this in a second LLM call per batch of ~10 sentences, separate from script writing, so the script stays natural and the annotation call can focus on accuracy.

## 3. Mobile learning features

| Feature | Behaviour |
|---|---|
| Synced transcript | Current sentence highlighted and auto-scrolled; tap a sentence to seek to it |
| Translation | Hidden by default; tap the sentence (or hold) to reveal. Setting: always show / tap to show / never |
| Word sheet | Tap a word → bottom sheet: surface form, lemma, part of speech, gloss, morpheme breakdown, "Save word", "Report error" |
| Sentence drill | Toggle. Auto-pause at each `endMs`; buttons: repeat, previous, next; optional auto-repeat ×2/×3 |
| Speed | 0.5× to 1.5× in 0.05 steps, pitch-corrected, remembered per mode |
| A–B loop | Long-press a sentence to loop it until dismissed |
| Vocabulary | Saved card = lemma + gloss + the sentence it was found in + episode id + segment `startMs`/`endMs` so review can replay the original audio |
| Review | FSRS via `ts-fsrs`, four ratings (Again/Hard/Good/Easy). Card front: Hungarian word + plays the sentence audio. Back: gloss, sentence, translation, morphemes. Daily new-card limit (default 10) |
| Progress | Count of known/learning words, review streak, minutes listened. No gamification beyond that |

Sentence-audio replay in review requires the episode to still be downloaded; if it was deleted, show the text only.

## 4. Adaptive loop

Phone vocabulary and FSRS progress remain local and are never automatically uploaded. Consequently automatic adaptation to phone due/known words is deferred; no cross-device recovery after reinstall is promised. A future manual PC-side vocabulary input or explicit backup needs a separate owner decision. The episode can still list `targetVocabulary`, and the app can offer "Save all target words". Level adjusts only by explicit user setting; do not auto-promote.

## 5. Quality controls for generated Hungarian

LLM Hungarian can be wrong, especially morphology explanations. Controls, in order:

1. Learning modes always use `LLM_MODEL_MAIN`.
2. `review` stage runs a dedicated proofreading prompt: correct grammar, vowel harmony, definite/indefinite conjugation, word order; then a level prompt: flag sentences above the target level and rewrite them.
3. Structural validation: tokens reconstruct the text; every `isTarget` lemma appears ≥ 3 times; sentence length limits hold. Violations trigger one automatic regeneration of the offending batch.
4. "Report error" in the word sheet marks a token; reported tokens are excluded from saving and retained locally for the owner to inspect; they are not automatically sent to the server.
5. Tell the learner honestly in the app's About screen that explanations are machine-generated and may contain mistakes.

A deterministic morphological analyser (for example a Hungarian hunspell dictionary or emMorph) for cross-checking lemmas is a possible later improvement; it is not in scope for the first version.

## 6. Voices

Default Hungarian voices on Azure: one female, one male neural voice. The `host` uses one consistently; the `teacher` (native-language explanations) uses a clearly different voice in the native language, so the learner always knows by ear which language is coming.
