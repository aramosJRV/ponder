// Notification abstraction. v1 uses Capacitor Local Notifications (no APNs/FCM):
// the app syncs pre-generated content, then schedules a local notification with
// the day's verse. This interface is the seam an FCM/push implementation slots
// into later — nothing outside this folder should import a concrete notifier.

export interface DailyReminder {
  /** Stable id so re-syncing replaces the day's reminder instead of stacking. */
  id: number;
  /** Notification title — the topic name. */
  title: string;
  /** Notification body — verse ref + first line of the verse. */
  body: string;
  /** Local time to fire. */
  at: Date;
}

export interface Notifier {
  /** True when this platform can actually deliver notifications (native only in v1). */
  isSupported(): boolean;
  /** Request/confirm permission. Returns whether permission is granted. */
  ensurePermission(): Promise<boolean>;
  /** Schedule (or replace) the daily verse reminder. */
  scheduleDaily(reminder: DailyReminder): Promise<void>;
  /** Cancel any pending daily reminder (e.g. no active topics / signed out). */
  cancelDaily(): Promise<void>;
}

/** Fixed id for the single daily reminder — reused so scheduling is idempotent. */
export const DAILY_REMINDER_ID = 1001;
