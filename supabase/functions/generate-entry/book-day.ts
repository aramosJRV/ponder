// ------------------------------------------------------------------
// Book threads — one section (bible_pericopes) of a book per day.
//
// Unlike a topic entry, a book day is the SAME for every reader: written
// once per section, cached, served to everyone who reaches it. So the
// writer knows nothing about the reader — no thread, no history, no
// elapsed time — and the writing must read correctly under any of the
// three translations, because the passage shown above it is the reader's
// own (WEB / BSB / KJV, from bible_verses, never from model output).
//
// Pure module: no env, no network. checkBookDay is the machine half of the
// content check; scripts/book-day-preview.ts adds the model-review half
// and writes nothing to the database. book-day.test.ts proves the checker
// catches what it claims to.
// ------------------------------------------------------------------

export const BOOK_TRANSLATIONS = ["WEB", "BSB", "KJV"] as const;
export type BookTranslation = typeof BOOK_TRANSLATIONS[number];

export type Section = {
  book: string;
  /** 1-based position in the book and the book's section count. */
  index: number;
  count: number;
  chapter_start: number;
  verse_start: number;
  chapter_end: number;
  verse_end: number;
  /** Whole section text per translation, verses joined by spaces. */
  texts: Partial<Record<BookTranslation, string>>;
};

export type BookDay = {
  key_verse: { chapter: number; verse_start: number; verse_end: number };
  thought: string;
  illustration: string;
  ponder: string[];
  prayer_prompts: string[];
};

export const LIMITS = {
  thought: [120, 220],
  illustration: [80, 180],
  ponder: [2, 3],
  prayer: [2, 3],
  itemWords: 35,
  keyVerseSpan: 3,
} as const;

export const sectionRef = (s: Section) =>
  s.chapter_start === s.chapter_end
    ? `${s.book} ${s.chapter_start}:${s.verse_start}-${s.verse_end}`
    : `${s.book} ${s.chapter_start}:${s.verse_start}-${s.chapter_end}:${s.verse_end}`;

export const BOOK_DAY_SYSTEM = `You write one reading in a slow read-through of a book of the Bible, one section at a time. The reader sees the full section in their own translation (World English Bible, Berean Standard Bible or King James Version) directly above what you write, then your writing, then questions to ponder and directions for prayer.

The same writing is shown to EVERY reader who reaches this section. You know nothing about them: not why they are reading, not what is going on in their life, not how they got here or how long it has taken. Write to the passage, and to a person reading it now.

What to write:
- thought: walk through the WHOLE section first, so the reader sees what happens or what is said and why it matters in the book, then slow down on ONE key verse (or two or three consecutive verses) from inside this section that carries its weight. Say plainly what that verse says before reflecting on it.
- illustration: an image, analogy or ordinary scene that opens up the key verse. Clearly framed as illustration ("Imagine...", "Think of..."), or something true and commonly known.
- ponder: two or three questions to sit with, each a single short question (under 25 words) ending in a question mark, different in angle from each other. Questions about the passage and about the reader's life with God, never quizzes.
- prayer: two or three short directions for prayer, each one plain sentence (under 25 words) that grows out of the passage.

Length: thought 130 to 190 words, illustration 90 to 160 words. Stay inside these.

Accuracy: before writing, read the whole section in all three translations and notice who is present, what happens and how it ends. Say nothing the section does not say. Be careful with absolute words ("all", "none", "nothing", "only", "alone"): use one only when the passage says it. Do not leave out people who are still in the scene at the end, and do not import details from elsewhere in the book as if they were in this section. Describe each person from their own place in the story (a Moabite woman in Moab is not in a foreign land). Say who does what: never use a passive ("she was put outside") that hides who did it.

Settled and unsettled: where Christians have long read a passage a particular way but others read it differently, give it as a reading ("many Christians have seen here..."), not as the plain meaning of the words. Do not take a position on how historical the earliest figures of Genesis are, or on the date and authorship of a book; speak of people and events as the text presents them.

Non-negotiable:
1. Never claim God is telling the reader something, and never direct their life decisions. Invite: "consider", "notice", "sit with".
2. Handle the section in its own context and in the context of the book. Never use a phrase against the meaning of its passage.
3. Never invent quotes, statistics, historical anecdotes or named people presented as fact.
4. Broadly orthodox, non-denominational Christian posture. Where Christians genuinely disagree, you may describe the views Christians have held, but never decide it for the reader. No partisan politics.
5. QUOTING: the reader may be looking at any of three translations, and their wording differs ("Yahweh", "the LORD"; "thee", "you"). Do not quote the passage. Describe it in your own words. If you truly need a few words in quotation marks, they must be words that read identically in all three translations you are given. Never quote any other passage or any other writer.
6. TIME: never state or imply anything about time on the reader's side. Never use the words "day", "days", "today", "tomorrow", "yesterday", "week", "month", "year", "daily", "lately", "recently", "so far", "journey", "season", "you've been", "you have been", "as we've seen", "last time" — unless the word appears in the passage itself and you are describing the passage. Do not count readings, do not mention the reader's progress, do not say "this reading" is part of a series. You may refer to earlier or later parts of the book by what happens in them ("earlier in Mark, Jesus..."), never by when the reader read them.
7. Never use the word "thread". Never address the reader's reasons for reading.
8. OTHER PEOPLES AND FAITHS: describe the nations, gods and practices in the passage as the passage describes them, without adding contempt. Never comment on any present-day religion or on Jewish people, past or present. Never use "pagan", "heathen", "primitive", "superstitious", "barbaric" or "savage" in your own voice. Do not caricature the law, priests, Pharisees or Israel as foils for the gospel.
9. Plain text only: no headings, bullets, bold, asterisks or numbering.

Hard passages:
- Violence and cruelty: name what happens plainly and soberly. Do not soften it, do not sensationalise it, and do not hurry to a moral. Notice what the text itself does with it (often it is showing how far things have fallen), and let the reader feel the weight. Never suggest a victim deserved it. Do not tell the reader how to feel.
- Genealogies and lists: do not pretend a list is thrilling and do not apologise for it. Say what the list is doing in the book (who is remembered, who is included, where the story is going) and choose a name or a turn in it worth stopping on.
- Law and sacrifice: explain what the instruction meant in its own world and what it teaches about God and his people. Do not treat it as foolish or as a mere step to be discarded.
- Poetry and love poetry (Psalms, Song of Songs): let the poem be a poem. In the Song of Songs, read it first as love poetry between a woman and a man; you may mention that many Christians have also read it as a picture of God's love, without deciding between readings. Be warm and restrained; never coy, never explicit.

Never write self-improvement: no steps, techniques, principles or plans. If a paragraph would still work in a leadership book with God removed from it, rewrite it.

Respond only by calling the record_book_day tool.`;

const BOOK_DAY_TOOL = {
  name: "record_book_day",
  description: "Record the reading for this section.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["key_verse", "thought", "illustration", "ponder_1", "ponder_2", "prayer_1", "prayer_2"],
    properties: {
      key_verse: {
        type: "object",
        additionalProperties: false,
        required: ["chapter", "verse_start", "verse_end"],
        properties: {
          chapter: { type: "integer" },
          verse_start: { type: "integer" },
          verse_end: { type: "integer", description: "Same as verse_start for one verse; at most two more." },
        },
      },
      thought: { type: "string", description: "130-190 words: the whole section, then the key verse." },
      illustration: { type: "string", description: "90-160 words, clearly illustrative." },
      // Fixed slots, not arrays: see the note on DEVOTIONAL_TOOL in index.ts.
      ponder_1: { type: "string", description: "One short question (under 25 words), ending in a question mark." },
      ponder_2: { type: "string", description: "A second question, different in angle." },
      ponder_3: { type: "string", description: "OPTIONAL third question. Omit rather than pad." },
      prayer_1: { type: "string", description: "One short prayer direction, one sentence." },
      prayer_2: { type: "string", description: "A second prayer direction." },
      prayer_3: { type: "string", description: "OPTIONAL third prayer direction. Omit rather than pad." },
    },
  },
};

/** Messages API request body for writing one section. */
/**
 * With `fix`, the writer gets its own draft and the problems found in it,
 * and returns a corrected reading (the fix-up round).
 */
export function bookDayRequest(model: string, s: Section, fix?: { day: BookDay; problems: string[] }) {
  const shown = BOOK_TRANSLATIONS.filter((t) => s.texts[t]);
  return {
    model,
    max_tokens: 16000,
    output_config: { effort: "high" },
    system: BOOK_DAY_SYSTEM,
    tools: [BOOK_DAY_TOOL],
    tool_choice: { type: "auto" },
    messages: [{
      role: "user",
      content:
        `BOOK: ${s.book} (section ${s.index} of ${s.count} — for your orientation only; never mention it)\n` +
        `SECTION: ${sectionRef(s)}\n\n` +
        shown.map((t) => `${t}:\n${s.texts[t]}`).join("\n\n") +
        (fix
          ? `\n\nYOUR DRAFT:\n${JSON.stringify(fix.day, null, 2)}\n\nPROBLEMS FOUND IN IT:\n` +
            fix.problems.map((x) => `- ${x}`).join("\n") +
            `\n\nCheck each problem against the passage. Fix every real one, change nothing else that is sound, ` +
            `and record the whole corrected reading with record_book_day.`
          : `\n\nWrite the reading for this section and record it with record_book_day.`),
    }],
  };
}

/** Tool input -> BookDay. Never throws; missing parts surface in checkBookDay. */
export function parseBookDay(input: unknown): BookDay {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const kv = (raw.key_verse ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === "string" ? String(raw[k]).trim() : "");
  const slots = (keys: string[]) => keys.map(str).filter(Boolean);
  return {
    key_verse: { chapter: Number(kv.chapter), verse_start: Number(kv.verse_start), verse_end: Number(kv.verse_end) },
    thought: str("thought"),
    illustration: str("illustration"),
    ponder: slots(["ponder_1", "ponder_2", "ponder_3"]),
    prayer_prompts: slots(["prayer_1", "prayer_2", "prayer_3"]),
  };
}

// ------------------------------------------------------------ review + loop

const REVIEW_TOOL = {
  name: "record_review",
  description: "Record every problem found. An empty list means the reading is clean.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["problems"],
    properties: {
      problems: {
        type: "array",
        items: { type: "string" },
        description: "One plain sentence per problem, quoting the words at fault. Empty if none.",
      },
    },
  },
};

const REVIEW_SYSTEM = `You are reviewing a devotional reading written for a slow read-through of a book of the Bible. Below are the exact guidelines the writer was given, between the markers. Check the reading against every one of them, and also check that it describes the passage accurately: nothing the passage does not say, nothing important misread, no factual or theological error.

List only real problems: a broken guideline, an inaccuracy, a claim about the reader's time or progress, belittling or interpretive wording about other peoples or faiths, a verdict about what God is telling the reader, self-improvement, or a hard passage handled glibly. Do not list matters of taste or ways it could be "even better". Do not report length or word counts: those are checked by machine. If there are no real problems, return an empty list.

=== WRITER GUIDELINES ===
${BOOK_DAY_SYSTEM}
=== END GUIDELINES ===

Respond only by calling the record_review tool.`;

function reviewRequest(model: string, s: Section, d: BookDay) {
  return {
    model,
    max_tokens: 16000,
    output_config: { effort: "high" },
    system: REVIEW_SYSTEM,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "auto" },
    messages: [{
      role: "user",
      content:
        `SECTION: ${sectionRef(s)}\n\n` +
        BOOK_TRANSLATIONS.filter((t) => s.texts[t]).map((t) => `${t}:\n${s.texts[t]}`).join("\n\n") +
        `\n\nREADING TO REVIEW:\n${JSON.stringify(d, null, 2)}`,
    }],
  };
}

/** Calls the model with a request body and returns the named tool's input. */
export type CallTool = (body: Record<string, unknown>, tool: string) => Promise<unknown>;

export const FIX_ROUNDS = 2;

export type CheckedBookDay = {
  day: BookDay;
  clean: boolean;
  machine: string[];
  review: string[];
  /** Problems sent back in each fix-up round, oldest first. */
  fixed: string[][];
};

/**
 * Write a section, then check it: machine checks first (free), the model
 * review only once those pass. Any problems go back to the writer, up to
 * FIX_ROUNDS times. Only a `clean` result may be shown to a reader.
 */
export async function writeCheckedBookDay(
  s: Section,
  call: CallTool,
  opts: { writer: string; reviewer: string },
): Promise<CheckedBookDay> {
  let day = parseBookDay(await call(bookDayRequest(opts.writer, s), "record_book_day"));
  const fixed: string[][] = [];
  for (let round = 0; ; round++) {
    const machine = checkBookDay(day, s);
    const review = machine.length ? [] : reviewProblems(await call(reviewRequest(opts.reviewer, s, day), "record_review"));
    const clean = !machine.length && !review.length;
    if (clean || round === FIX_ROUNDS) return { day, clean, machine, review, fixed };
    const problems = [...machine, ...review];
    fixed.push(problems);
    day = parseBookDay(await call(bookDayRequest(opts.writer, s, { day, problems }), "record_book_day"));
  }
}

function reviewProblems(input: unknown): string[] {
  const p = (input as { problems?: unknown })?.problems;
  // A malformed review is not a pass.
  if (!Array.isArray(p)) return ["reviewer returned no problem list"];
  return p.map(String).map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- checker

const fold = (s: string) =>
  s.toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Banned unless the same word is in the passage (Leviticus: "the seventh day"). */
const TIME_WORDS = [
  "day", "days", "today", "tomorrow", "yesterday", "daily", "week", "weeks", "weekly",
  "month", "months", "year", "years", "lately", "recently", "journey", "season", "seasons", "streak",
];
/** Banned outright: these only ever describe the reader's time or progress. */
const TIME_PHRASES = [
  /\bso far\b/, /\buntil now\b/, /\bby now\b/, /\ball this time\b/, /\byou'?ve been\b/, /\byou have been\b/,
  /\bas we'?ve seen\b/, /\bas we saw\b/, /\blast time\b/, /\bwe'?ve been reading\b/, /\byou'?ve read\b/,
  /\byou have read\b/, /\bkeep coming back\b/, /\bthis reading\b/, /\bnext reading\b/, /\bprevious reading\b/,
];
/** Belittling or other-faith words, banned unless the passage itself uses them. */
const FAITH_WORDS = [
  "pagan", "pagans", "heathen", "heathens", "primitive", "superstitious", "superstition", "barbaric",
  "barbarian", "savage", "savages", "islam", "muslim", "muslims", "hindu", "hinduism", "buddhist",
  "buddhism", "mormon", "mormons", "atheist", "atheists", "judaism", "jewish", "jews", "rabbinic",
  "talmud", "legalism", "legalistic", "heretic", "heretics",
];
const VERDICT = [/\bgod is (telling|saying to|asking) you\b/, /\bgod wants you to\b/, /\bthis means you should\b/];

/** Every problem with a book day, as plain sentences. Empty means it passes. */
export function checkBookDay(d: BookDay, s: Section): string[] {
  const p: string[] = [];
  const texts = BOOK_TRANSLATIONS.map((t) => s.texts[t]).filter((x): x is string => !!x);
  if (!texts.length) return ["no passage text to check against"];

  // Shape and length
  const tw = words(d.thought), iw = words(d.illustration);
  if (tw < LIMITS.thought[0] || tw > LIMITS.thought[1]) p.push(`thought is ${tw} words (want ${LIMITS.thought.join("-")})`);
  if (iw < LIMITS.illustration[0] || iw > LIMITS.illustration[1]) {
    p.push(`illustration is ${iw} words (want ${LIMITS.illustration.join("-")})`);
  }
  if (d.ponder.length < LIMITS.ponder[0] || d.ponder.length > LIMITS.ponder[1]) p.push(`${d.ponder.length} ponder questions (want 2-3)`);
  if (d.prayer_prompts.length < LIMITS.prayer[0] || d.prayer_prompts.length > LIMITS.prayer[1]) {
    p.push(`${d.prayer_prompts.length} prayer lines (want 2-3)`);
  }
  for (const q of d.ponder) {
    if (!q.endsWith("?")) p.push(`ponder question does not end with "?": ${q}`);
    if (words(q) > LIMITS.itemWords) p.push(`ponder question over ${LIMITS.itemWords} words: ${q}`);
  }
  for (const q of d.prayer_prompts) {
    if (words(q) > LIMITS.itemWords) p.push(`prayer line over ${LIMITS.itemWords} words: ${q}`);
  }

  // Key verse inside the section, 1-3 verses
  const { chapter, verse_start, verse_end } = d.key_verse;
  if (![chapter, verse_start, verse_end].every(Number.isInteger)) {
    p.push("key verse is missing or not whole numbers");
  } else {
    const ord = (c: number, v: number) => c * 1000 + v;
    const lo = ord(s.chapter_start, s.verse_start), hi = ord(s.chapter_end, s.verse_end);
    if (ord(chapter, verse_start) < lo || ord(chapter, verse_end) > hi) {
      p.push(`key verse ${chapter}:${verse_start}-${verse_end} is outside ${sectionRef(s)}`);
    }
    if (verse_end < verse_start || verse_end - verse_start + 1 > LIMITS.keyVerseSpan) {
      p.push(`key verse spans ${verse_end - verse_start + 1} verses (want 1-${LIMITS.keyVerseSpan})`);
    }
  }

  const fields = [d.thought, d.illustration, ...d.ponder, ...d.prayer_prompts];
  const all = fields.join("\n");
  const foldedTexts = texts.map(fold);
  const passageWords = new Set(foldedTexts.join(" ").split(" "));

  // Quotes must read the same in every translation (hard rule 4)
  for (const m of all.matchAll(/["“]([^"”]+)["”]/g)) {
    const q = fold(m[1]);
    if (!q) continue;
    const missing = BOOK_TRANSLATIONS.filter((t) => s.texts[t] && !` ${fold(s.texts[t]!)} `.includes(` ${q} `));
    if (missing.length) p.push(`quote "${m[1]}" is not word-for-word in ${missing.join(", ")}`);
  }

  // Words
  const lower = all.toLowerCase().replace(/[‘’]/g, "'");
  const wordsUsed = new Set(fold(all).split(" "));
  for (const w of TIME_WORDS) {
    if (wordsUsed.has(w) && !passageWords.has(w)) p.push(`time word "${w}" (not in the passage)`);
  }
  for (const re of TIME_PHRASES) if (re.test(lower)) p.push(`time phrase ${re.source.replace(/\\b/g, "")}`);
  for (const w of FAITH_WORDS) {
    if (wordsUsed.has(w) && !passageWords.has(w)) p.push(`other-faith or belittling word "${w}"`);
  }
  for (const re of VERDICT) if (re.test(lower)) p.push(`tells the reader what God is saying: ${re.source.replace(/\\b/g, "")}`);
  if (/\bthreads?\b/.test(lower)) p.push(`uses the word "thread"`);
  if (/[*#]|^\s*[-•]\s/m.test(all)) p.push("contains formatting (asterisks, hashes or bullets)");

  return p;
}
