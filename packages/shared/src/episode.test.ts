import { describe, expect, test } from "vitest";
import {
  EpisodeSchema,
  EpisodeSegmentSchema,
  LangSchema,
  ModeSchema,
  ScriptSegmentSchema,
  TokenSchema,
  type Episode,
} from "./index.ts";
import {
  minimalScriptSegment,
  validEpisode,
  validEpisodeSegment,
  validScriptSegment,
  validToken,
} from "./fixtures.ts";
import { expectInvalid, expectValid } from "./testing.ts";

describe("Lang and Mode", () => {
  test("accept valid values", () => {
    for (const lang of ["en", "hu", "de", "pt-BR"]) expectValid(LangSchema, lang);
    for (const mode of ["standard", "graded", "bilingual"]) expectValid(ModeSchema, mode);
  });

  test("reject invalid values", () => {
    expectInvalid(LangSchema, "", /BCP-47/);
    expectInvalid(LangSchema, "Hungarian!", /BCP-47/);
    expectInvalid(LangSchema, 5, /string/);
    expectInvalid(ModeSchema, "podcast", /standard.*graded.*bilingual/);
  });
});

describe("Token", () => {
  test("accepts a full token and a token without optional fields", () => {
    expectValid(TokenSchema, validToken);
    expectValid(TokenSchema, { surface: "lakom", lemma: "lakik", pos: "verb", gloss: "I live" });
  });

  test("rejects a missing lemma", () => {
    const { lemma: _lemma, ...rest } = validToken;
    void _lemma;
    expectInvalid(TokenSchema, rest, /lemma/);
  });

  test("rejects a malformed morpheme, naming its path", () => {
    expectInvalid(
      TokenSchema,
      { ...validToken, morphemes: [{ form: "ház" }] },
      /morphemes\[0\]\.meaning/,
    );
  });

  test("rejects an empty surface and a non-boolean isTarget", () => {
    expectInvalid(TokenSchema, { ...validToken, surface: "" }, /surface/);
    expectInvalid(TokenSchema, { ...validToken, isTarget: "yes" }, /isTarget.*boolean/);
  });
});

describe("ScriptSegment", () => {
  test("accepts full and minimal segments", () => {
    expectValid(ScriptSegmentSchema, validScriptSegment);
    expectValid(ScriptSegmentSchema, minimalScriptSegment);
    expectValid(ScriptSegmentSchema, { ...minimalScriptSegment, repeatOf: "seg-0001" });
  });

  test("rejects an unknown kind and speaker with the allowed options listed", () => {
    expectInvalid(ScriptSegmentSchema, { ...validScriptSegment, kind: "advert" }, /kind.*intro/);
    expectInvalid(
      ScriptSegmentSchema,
      { ...validScriptSegment, speaker: "narrator" },
      /speaker.*host/,
    );
  });

  test("rejects a rate outside 0.7–1.1", () => {
    expectInvalid(ScriptSegmentSchema, { ...validScriptSegment, rate: 1.5 }, /rate.*1\.1/);
    expectInvalid(ScriptSegmentSchema, { ...validScriptSegment, rate: 0.5 }, /rate.*0\.7/);
  });

  test("rejects empty text, a negative pause and a bad token", () => {
    expectInvalid(ScriptSegmentSchema, { ...validScriptSegment, text: "" }, /text/);
    expectInvalid(ScriptSegmentSchema, { ...validScriptSegment, pauseAfterMs: -1 }, /pauseAfterMs/);
    expectInvalid(
      ScriptSegmentSchema,
      { ...validScriptSegment, tokens: [{ ...validToken, gloss: 3 }] },
      /tokens\[0\]\.gloss/,
    );
  });

  test("rejects a non-object", () => {
    expectInvalid(ScriptSegmentSchema, "seg-0001", /object/);
  });
});

describe("EpisodeSegment", () => {
  test("accepts a timed segment", () => {
    expectValid(EpisodeSegmentSchema, validEpisodeSegment);
  });

  test("rejects missing or fractional timings", () => {
    expectInvalid(EpisodeSegmentSchema, validScriptSegment, /startMs/, /endMs/);
    expectInvalid(EpisodeSegmentSchema, { ...validEpisodeSegment, startMs: 1.5 }, /startMs/);
  });

  test("rejects endMs before startMs", () => {
    expectInvalid(
      EpisodeSegmentSchema,
      { ...validEpisodeSegment, startMs: 3000, endMs: 2000 },
      /endMs must not be before startMs/,
    );
  });
});

describe("Episode", () => {
  test("accepts a valid episode and infers the literal schemaVersion", () => {
    const episode: Episode = EpisodeSchema.parse(validEpisode);
    const version: 1 = episode.schemaVersion;
    expect(version).toBe(1);
    expect(episode.segments).toHaveLength(2);
  });

  test("accepts an episode without the optional fields", () => {
    const { topicId, level, targetVocabulary, ...rest } = validEpisode;
    void topicId;
    void level;
    void targetVocabulary;
    expectValid(EpisodeSchema, rest);
  });

  test("rejects a wrong schemaVersion", () => {
    for (const schemaVersion of [2, 0, "1", null]) {
      expectInvalid(EpisodeSchema, { ...validEpisode, schemaVersion }, /schemaVersion.*expected 1/);
    }
  });

  test("rejects a missing schemaVersion", () => {
    const { schemaVersion, ...rest } = validEpisode;
    void schemaVersion;
    expectInvalid(EpisodeSchema, rest, /schemaVersion/);
  });

  test("rejects a bad audio descriptor", () => {
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, audio: { ...validEpisode.audio, file: "audio.mp3" } },
      /audio\.file.*audio\.m4a/,
    );
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, audio: { ...validEpisode.audio, sha256: "xyz" } },
      /audio\.sha256.*64/,
    );
  });

  test("rejects a bad createdAt, level, source url and cost", () => {
    expectInvalid(EpisodeSchema, { ...validEpisode, createdAt: "yesterday" }, /createdAt/);
    expectInvalid(EpisodeSchema, { ...validEpisode, level: "C2" }, /level.*A1/);
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, sources: [{ ...validEpisode.sources[0], url: "not a url" }] },
      /sources\[0\]\.url/,
    );
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, sources: [{ ...validEpisode.sources[0], url: "file:///etc/passwd" }] },
      /sources\[0\]\.url.*http/,
    );
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, generation: { ...validEpisode.generation, costUsd: -1 } },
      /generation\.costUsd/,
    );
  });

  test("reports the path of a bad nested segment", () => {
    expectInvalid(
      EpisodeSchema,
      { ...validEpisode, segments: [validEpisodeSegment, { ...validEpisodeSegment, text: 7 }] },
      /segments\[1\]\.text/,
    );
  });

  test("reports every problem, one per line", () => {
    const message = expectInvalid(EpisodeSchema, { schemaVersion: 1 }, /id/, /title/, /segments/);
    expect(message.split("\n").length).toBeGreaterThan(5);
  });
});
