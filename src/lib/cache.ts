// Offline cache for today's synced content. localStorage is sufficient for
// one day's entries; swap for Capacitor Preferences/SQLite later if needed.

import type { DailyEntry, Note, Topic } from "./types";

interface TodayCache {
  date: string;
  topics: Topic[];
  entries: DailyEntry[];
  notes: Note[];
  cached_at: string;
}

const KEY = "promptings.today.v1";

export function saveTodayCache(data: Omit<TodayCache, "cached_at">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...data, cached_at: new Date().toISOString() }));
  } catch {
    /* quota/private mode — cache is best-effort */
  }
}

export function loadTodayCache(date: string): TodayCache | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TodayCache;
    return parsed.date === date ? parsed : null;
  } catch {
    return null;
  }
}
