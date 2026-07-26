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
