export type TopicStatus = "active" | "paused" | "concluded";

/**
 * How much of an entry is shown by default.
 * 1 = passage + questions · 2 = + thought · 3 = full (illustration, prayer, song)
 *
 * Display only. Every entry is always generated and stored in full; the level
 * decides what is open when the card first renders, not what exists.
 */
export type ContentLevel = 1 | 2 | 3;

/**
 * Public-domain Bible translations. Mirrors the bible_translations table.
 *
 * There is no NIV / ESV / MSG / NLT / NASB / CSB member and there cannot be
 * one: those are copyright-protected and cannot be stored in bible_verses,
 * copied into daily_entries.verse_text, shared through entry_pool or put in
 * a notification payload without a commercial licence. Adding a member here
 * without a licence and a row in bible_translations does not make the text
 * appear — it makes a tab that resolves to nothing.
 */
export type Translation = "WEB" | "BSB" | "KJV";

export interface Profile {
  id: string;
  timezone: string;
  notification_hour: number; // 0–23, local hour to fire the daily reminder
  challenge_frequency: number; // 0.00–0.50
  content_level: ContentLevel;
  /** Standing preference. What new entries and the notification body are
   *  rendered in. Per-passage tab switching does NOT write here. */
  translation: Translation;
}
export type EntryType = "affirming" | "challenge";

export interface Topic {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: TopicStatus;
  focus: boolean;
  created_at: string;
  concluded_at: string | null;
  /** The passage that triggered the pondering. Optional; all-or-nothing. */
  seed_book_number: number | null;
  seed_chapter: number | null;
  seed_verse_start: number | null;
  seed_verse_end: number | null;
  seed_verse_ref: string | null;
  /** WEB text, written server-side by trigger — never client-supplied. */
  seed_verse_text: string | null;
}

/** Result of the parse_verse_ref RPC — a reference that exists in the
 *  translation it was validated against (the WEB unless one was named). */
export interface ResolvedVerseRef {
  book_number: number;
  book: string;
  chapter: number;
  verse_start: number;
  verse_end: number;
  verse_ref: string;
  verse_text: string;
}

/**
 * A supporting passage cited in an entry's footnote. Written only after the
 * reference resolved against the WEB table server-side, so every element here
 * exists in scripture. Deliberately carries no text — text is read from
 * bible_verses, never from a citation.
 */
export interface CrossRef {
  ref: string; // display form, e.g. 'Romans 8:26'
  book: string;
  chapter: number;
  verse_start: number;
  verse_end: number;
}

/**
 * One verse of a passage-context read (the `passage_context` RPC).
 *
 * The range bounds repeat on every row — the sheet header needs them and a
 * second round trip for four integers is not worth it.
 *
 * `verse_text` is null when that verse is absent from the requested
 * translation. That is a real answer, not a failure: the WEB is the skeleton
 * and the chosen translation is joined onto it, so the gap is shown rather
 * than silently closed up.
 */
export interface PassageContextRow {
  start_chapter: number;
  start_verse: number;
  end_chapter: number;
  end_verse: number;
  chapter: number;
  verse: number;
  verse_text: string | null;
}

export interface DailyEntry {
  id: string;
  topic_id: string;
  user_id: string;
  date: string; // YYYY-MM-DD
  verse_ref: string;
  book_number: number;
  chapter: number;
  verse_start: number;
  verse_end: number;
  verse_text: string;
  thought: string;
  illustration: string;
  ponder: string[];
  prayer_prompts: string[];
  entry_type: EntryType;
  fallback_used: boolean;
  /** Validated supporting references. Absent on entries generated before footnotes shipped. */
  cross_refs?: CrossRef[] | null;
  /**
   * Verified Spotify track, or null. Every field came from a Spotify API
   * response, never from model output. Always null on challenge entries
   * (they arrive deliberately quieter) and on entries generated before this
   * shipped, so the UI must treat absence as normal.
   */
  song?: Song | null;
  created_at: string;
}

export interface Note {
  id: string;
  entry_id: string;
  topic_id: string;
  user_id: string;
  body: string;
  created_at: string;
}

export type SynthesisKind = "on_demand" | "conclusion";

/** What a synthesis was built from. Computed server-side, not model output. */
export interface SynthesisSources {
  entry_refs: string[];
  entry_count: number;
  note_count: number;
  first_entry_date: string | null;
  last_entry_date: string | null;
  model: string;
}

export interface SynthesisContent {
  threads: string[];
  tensions: string[];
  next_steps: string[];
  /** Absent on syntheses generated before footnotes shipped. */
  sources?: SynthesisSources | null;
}

export interface Synthesis {
  id: string;
  topic_id: string;
  user_id: string;
  kind: SynthesisKind;
  content: SynthesisContent;
  created_at: string;
}

// ---------------------------------------------------------------- reports

export type ReportTarget = "daily_entry" | "synthesis";

export type ReportReason =
  | "offensive"
  | "harmful_guidance"
  | "scripture_error"
  | "nonsense"
  | "other";

export interface ContentReport {
  id: string;
  user_id: string;
  target: ReportTarget;
  entry_id: string | null;
  synthesis_id: string | null;
  reason: ReportReason;
  detail: string | null;
  reported_content: unknown;
  resolved_at: string | null;
  created_at: string;
}

/**
 * A Spotify track attached to an entry.
 *
 * `name` and `artist` are Spotify's own strings and must be rendered
 * verbatim — Spotify's branding guidelines require it, and it is also the
 * point: the model's spelling never reaches the screen.
 */
export interface Song {
  track_id: string;
  name: string;
  artist: string;
  url: string;
  art?: string | null;
}
