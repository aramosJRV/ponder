// Public entry point for the notification layer. Callers use getNotifier() and
// scheduleDailyVerse() — they never import a concrete implementation, so an
// FCM/push notifier can replace CapacitorNotifier here without touching screens.

import type { DailyEntry, Topic } from "../types";
import { CapacitorNotifier } from "./capacitor";
import { DAILY_REMINDER_ID, type Notifier } from "./types";

export type { Notifier, DailyReminder } from "./types";

let instance: Notifier | null = null;

export function getNotifier(): Notifier {
  // Single seam to swap in an FCM-backed Notifier later.
  if (!instance) instance = new CapacitorNotifier();
  return instance;
}

/** Next local occurrence of `hour` (today if still upcoming, else tomorrow). */
export function nextOccurrence(hour: number, now = new Date()): Date {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

function firstLine(verseText: string): string {
  const clean = verseText.replace(/\s+/g, " ").trim();
  // Keep the notification body short — first sentence or ~90 chars.
  const stop = clean.search(/[.!?]\s/);
  const cut = stop > 0 && stop < 90 ? stop + 1 : Math.min(clean.length, 90);
  return clean.length > cut ? clean.slice(0, cut).trimEnd() + "…" : clean;
}

/**
 * Schedule the daily verse reminder for the focus/rotating topic's entry.
 * Called after Today syncs. No-ops safely on web and when nothing to show.
 * Title = topic name; body = verse ref + first line of the verse.
 */
export async function scheduleDailyVerse(input: {
  topic: Topic;
  entry: DailyEntry;
  notificationHour: number;
}): Promise<void> {
  const notifier = getNotifier();
  if (!notifier.isSupported()) return;
  const granted = await notifier.ensurePermission();
  if (!granted) return;

  await notifier.scheduleDaily({
    id: DAILY_REMINDER_ID,
    title: input.topic.title,
    body: `${input.entry.verse_ref} — ${firstLine(input.entry.verse_text)}`,
    at: nextOccurrence(input.notificationHour),
  });
}
