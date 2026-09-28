// ------------------------------------------------------------------
// Meditate — the phrases a reader is walked through, one per screen,
// before the ponder questions. Small to large: "Trust", "Trust in
// Yahweh", "with all your heart", "lean not".
//
// Same second-pass shape as the verse-anchored question, for the same
// reason: the real passage text is in front of the model, so a phrase is
// a copy, not a recollection. Unlike the question it is asked for ALL
// THREE public-domain translations at once, because the client walks the
// list matching the translation on screen and a WEB phrase is often not
// in BSB or KJV. One call, three lists.
//
// Only phrases — no commentary under them. The reader brings the thought.
//
// Pure module: no env, no network. index.ts makes the call and records
// the spend; scripts/meditation-preview.ts imports the same prompt and
// verification so a preview tests exactly what ships.
// ------------------------------------------------------------------

export const MEDITATION_TRANSLATIONS = ["WEB", "BSB", "KJV"] as const;
export type MeditationTranslation = typeof MEDITATION_TRANSLATIONS[number];
export type Meditation = Partial<Record<MeditationTranslation, string[]>>;
export type MeditationTexts = Partial<Record<MeditationTranslation, string>>;

/** A translation with fewer verified phrases than this gets no Meditate. */
const MIN_PHRASES = 2;
const MAX_PHRASES = 10;
/**
 * How many phrases to ask for scales with the passage (Antonio, 28 Sep
 * 2026: longer passages felt thin with only a handful). Word count is the
 * longest version shown. Up to 30 words: three to five; up to 60: five to
 * seven; longer: seven to nine.
 */
const MEDIUM_PASSAGE_WORDS = 30;
const LONG_PASSAGE_WORDS = 60;
/** The prompt asks for one to four; this is the guard, with a little give. */
const MAX_WORDS = 6;

const PHRASES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Three to nine phrases (as many as the message asks for) of one to four words each, " +
    "COPIED CHARACTER FOR CHARACTER from this " +
    "translation's text, in the order the reader should dwell on them. The first is a single word. " +
    "Not a paraphrase, not modernised, no ellipsis.",
};

const TOOL = {
  name: "record_meditation",
  description: "Record the phrases to dwell on, per translation.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [...MEDITATION_TRANSLATIONS],
    properties: Object.fromEntries(MEDITATION_TRANSLATIONS.map((t) => [t, PHRASES_SCHEMA])),
  },
};

// Measured 26 Sep 2026: with only "one to six words" and "begin small",
// Haiku returned whole clauses ("you shall not harden your heart" -> "nor
// shut your hand from your poor brother") and never a single word, which
// chops the verse up instead of slowing it down. Hence hard numbers, the
// explicit widening rule and the worked example.
const SYSTEM =
  "You guide a slow, meditative reading of a Bible passage. The reader sees one phrase at a time, " +
  "alone on the screen, and stays with it before moving on. Nothing else is shown with it. The point " +
  "is to slow down on a few words, not to cover the passage.\n\n" +
  "Choose SHORT phrases to pause on (the message says how many for this passage):\n" +
  "- Each phrase is ONE TO FOUR WORDS. Never a whole clause or sentence.\n" +
  "- The first phrase is a single word: the weightiest word in the passage.\n" +
  "- The walk widens at least once: a later phrase contains the one before it and adds a few words " +
  "(\"Trust\", then \"Trust in the LORD\").\n" +
  "- Then move on through the passage in order, picking the few words that carry the weight in each " +
  "part. Skip filler such as \"and\", \"for\", \"that\", \"therefore\".\n" +
  "- In a long passage, do not try to cover everything. Pick the moments most worth stopping on.\n\n" +
  "Example. Proverbs 3:5 (BSB): \"Trust in the LORD with all your heart, and lean not on your own " +
  "understanding;\" -> [\"Trust\", \"Trust in the LORD\", \"all your heart\", \"lean not\", " +
  "\"your own understanding\"]\n\n" +
  "You are given the same passage in three translations. For EACH translation, copy its phrases " +
  "CHARACTER FOR CHARACTER from that translation's text, exactly as it appears, including spelling " +
  "and capitalisation. Do not modernise, paraphrase or tidy. Keep the three walks parallel (the same " +
  "moments of the passage in each), but each list must come only from its own text.";

/** Messages API request body. Translations missing from `texts` are named as absent. */
export function meditationRequest(model: string, verseRef: string, texts: MeditationTexts) {
  const shown = MEDITATION_TRANSLATIONS.filter((t) => texts[t]);
  const words = Math.max(0, ...shown.map((t) => texts[t]!.trim().split(/\s+/).length));
  const count = words > LONG_PASSAGE_WORDS
    ? "seven to nine"
    : words > MEDIUM_PASSAGE_WORDS
    ? "five to seven"
    : "three to five";
  return {
    model,
    max_tokens: 800,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{
      role: "user",
      content:
        `PASSAGE: ${verseRef}\n\n` +
        shown.map((t) => `${t}:\n"${texts[t]}"`).join("\n\n") +
        (shown.length < MEDITATION_TRANSLATIONS.length
          ? "\n\nA translation not shown here does not contain this passage; return an empty list for it."
          : "") +
        `\n\nChoose ${count} phrases for each translation from its text above.`,
    }],
  };
}

/** Tool input -> verified phrases per translation, or null when none survive. */
export function parseMeditation(input: unknown, texts: MeditationTexts): Meditation | null {
  const out = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const result: Meditation = {};
  for (const t of MEDITATION_TRANSLATIONS) {
    const text = texts[t];
    if (!text) continue;
    const phrases = anchorMeditation(out[t], text);
    if (phrases.length >= MIN_PHRASES) result[t] = phrases;
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Keep only phrases that really are in the passage, stored AS SCRIPTURE
 * SPELLS THEM — sliced out of the text, never as the model retyped them —
 * because the client highlights by a plain indexOf.
 *
 * Stricter than the verse-question anchor in one way: the match must sit on
 * word boundaries, so "art" cannot be found inside "heart". Curly and
 * straight quotes and dashes are treated alike; those swaps are one
 * character for one, so the index still slices the original text correctly.
 */
export function anchorMeditation(raw: unknown, text: string): string[] {
  if (!Array.isArray(raw)) return [];
  const fold = (s: string) =>
    s.toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-");
  const hay = fold(text);
  const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of raw) {
    if (kept.length >= MAX_PHRASES) break;
    const phrase = String(item ?? "")
      .replace(/^["'“‘]+|["'”’.,;:!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!phrase || phrase.split(" ").length > MAX_WORDS) continue;
    const needle = fold(phrase);
    let at = hay.indexOf(needle);
    while (at >= 0 && (isWordChar(hay[at - 1]) || isWordChar(hay[at + needle.length]))) {
      at = hay.indexOf(needle, at + 1);
    }
    if (at < 0) continue;
    const slice = text.slice(at, at + phrase.length);
    const key = slice.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(slice);
  }
  return kept;
}
