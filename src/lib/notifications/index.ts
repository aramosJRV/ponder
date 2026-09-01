// Public entry point for the notification layer. Callers use getNotifier(),
// scheduleDailyVerse() and refreshDailyReminder() — they never import a
// concrete implementation, so an FCM/push notifier can replace
// CapacitorNotifier here without touching screens.

import {
  fetchActiveTopics,
  fetchEntriesForDate,
  fetchPassageText,
  fetchProfile,
} from "../api";
import { DEFAULT_TRANSLATION } from "../translations";
import { deviceTimezone, nextOccurrenceInZone, todayLocal } from "../dates";
import type { DailyEntry, Topic } from "../types";
import { CapacitorNotifier } from "./capacitor";
import { DAILY_REMINDER_ID, type Notifier } from "./types";

export type { Notifier, DailyReminder, PermissionStatus } from "./types";
export { DAILY_REMINDER_ID } from "./types";

/** Fallback when no profile has loaded yet. Keep in sync with the DB default. */
export const DEFAULT_NOTIFICATION_HOUR = 8;

let instance: Notifier | null = null;

export function getNotifier(): Notifier {
  // Single seam to swap in an FCM-backed Notifier later.
  if (!instance) instance = new CapacitorNotifier();
  return instance;
}

/**
 * Next occurrence of `hour` in the DEVICE's timezone.
 * Kept for callers that have no profile timezone; prefer nextOccurrenceInZone.
 */
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
 * No-ops safely on web and when permission is refused.
 */
export async function scheduleDailyVerse(input: {
  topic: Topic;
  entry: DailyEntry | null;
  notificationHour: number;
  /** The profile timezone the hour is expressed in. Defaults to the device's. */
  timezone?: string | null;
  /** Passage text in the reader's preferred version. Falls back to the WEB
   *  text the entry carries when it is null. */
  verseText?: string | null;
}): Promise<void> {
  const notifier = getNotifier();
  if (!notifier.isSupported()) return;
  const granted = await notifier.ensurePermission();
  if (!granted) return;

  // The reminder repeats daily at this hour. When today's entry hasn't been
  // generated yet we still schedule — with a generic body — so the user gets a
  // nudge instead of silence. Content is refreshed on the next app open.
  const body = input.entry
    ? `${input.entry.verse_ref} — ${firstLine(input.verseText || input.entry.verse_text)}`
    : "Your verse for today is ready to open.";

  await notifier.scheduleDaily({
    id: DAILY_REMINDER_ID,
    title: input.topic.title,
    body,
    // The hour is expressed in the PROFILE's timezone, but the OS calendar
    // trigger fires in the DEVICE's. Resolve to a real instant here; the
    // notifier reads the device-local hour/minute back off it.
    at: nextOccurrenceInZone(
      input.notificationHour,
      input.timezone || deviceTimezone() || "UTC",
    ),
    repeats: true,
  });
}

/** What refreshDailyReminder() actually did — surfaced in Settings so a
 * reminder that silently fails to schedule is visible instead of invisible. */
export type ReminderState =
  | { kind: "unsupported" }
  | { kind: "no-permission" }
  | { kind: "no-thread" }
  | {
      kind: "scheduled";
      hour: number;
      topicTitle: string;
      hasEntry: boolean;
      timezone: string;
      /** Device-local "HH:MM" the alarm actually fires at. Differs from `hour`
       *  only when the device timezone differs from the profile timezone. */
      deviceLocal: string;
    }
  | { kind: "error"; message: string };

/**
 * Re-read profile + focus topic + today's entry and (re)schedule the reminder.
 * Self-contained so any screen can call it — Settings after a save, Today after
 * a sync. Cancels the reminder when there is nothing to remind about.
 * Best-effort: never throws.
 */
export async function refreshDailyReminder(): Promise<ReminderState> {
  const notifier = getNotifier();
  if (!notifier.isSupported()) return { kind: "unsupported" };
  try {
    const granted = await notifier.ensurePermission();
    if (!granted) return { kind: "no-permission" };

    const [profile, topics] = await Promise.all([fetchProfile(), fetchActiveTopics()]);
    // fetchActiveTopics orders focus first, so topics[0] is the notification topic.
    const topic = topics[0] ?? null;
    if (!topic) {
      await notifier.cancelDaily();
      return { kind: "no-thread" };
    }
    let entry: DailyEntry | null = null;
    try {
      const entries = await fetchEntriesForDate(todayLocal());
      entry = entries.find((e) => e.topic_id === topic.id) ?? null;
    } catch {
      /* entry is a nice-to-have for the body — schedule regardless */
    }
    const hour = profile?.notification_hour ?? DEFAULT_NOTIFICATION_HOUR;
    const timezone = profile?.timezone || deviceTimezone() || "UTC";

    // The reminder has to say what the screen will say. daily_entries stores
    // the WEB, so a reader who prefers another version needs the passage
    // resolved before the alarm is armed — otherwise the notification quotes
    // one translation and the card they open quotes another. Best-effort:
    // a reminder in the WEB beats no reminder at all.
    let verseText: string | null = null;
    const translation = profile?.translation ?? DEFAULT_TRANSLATION;
    if (entry && translation !== DEFAULT_TRANSLATION) {
      try {
        verseText = await fetchPassageText(entry, translation);
      } catch {
        /* keep the text the entry carries */
      }
    }

    await scheduleDailyVerse({
      topic,
      entry,
      notificationHour: hour,
      timezone,
      verseText,
    });

    const at = nextOccurrenceInZone(hour, timezone);
    const deviceLocal = `${String(at.getHours()).padStart(2, "0")}:${String(
      at.getMinutes(),
    ).padStart(2, "0")}`;
    return {
      kind: "scheduled",
      hour,
      topicTitle: topic.title,
      hasEntry: !!entry,
      timezone,
      deviceLocal,
    };
  } catch (e) {
    // Previously swallowed. A reminder that fails to schedule must say so —
    // silent failure here is exactly what made the original bug invisible.
    return { kind: "error", message: e instanceof Error ? e.message : "Unknown error" };
  }
}
