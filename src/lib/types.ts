export type TopicStatus = "active" | "paused" | "concluded";

export interface Profile {
  id: string;
  timezone: string;
  notification_hour: number; // 0–23, local hour to fire the daily reminder
  challenge_frequency: number; // 0.00–0.50
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

/** Result of the parse_verse_ref RPC — a reference that exists in the WEB. */
export interface ResolvedVerseRef {
  book_number: number;
  book: string;
  chapter: number;
  verse_start: number;
  verse_end: number;
  verse_ref: string;
  verse_text: string;
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

export interface SynthesisContent {
  threads: string[];
  tensions: string[];
  next_steps: string[];
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
