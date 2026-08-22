// Capacitor Local Notifications implementation of Notifier.
//
// The plugin is accessed via registerPlugin() from @capacitor/core rather than a
// direct import of @capacitor/local-notifications, so the web build compiles
// without the native package present. The native package still must be
// installed and `npx cap sync`'d for on-device delivery.

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  DAILY_REMINDER_ID,
  TEST_NOTIFICATION_ID,
  type DailyReminder,
  type Notifier,
  type PermissionStatus,
} from "./types";

type PluginPermission = "prompt" | "prompt-with-rationale" | "granted" | "denied";

/**
 * Our own channel. The plugin's built-in "default" channel is created at
 * IMPORTANCE_DEFAULT, which on Android means the notification lands silently
 * in the shade with NO heads-up banner — very easy to miss, and it looked like
 * nothing had fired at all. Android refuses to raise the importance of an
 * existing channel, so the only fix is a new channel id at IMPORTANCE_HIGH.
 * Bump the id (not the importance) if this ever needs changing again.
 */
const CHANNEL_ID = "ponder-reminders-v1";

interface ScheduleSpec {
  /** One-off fire time. Mutually exclusive with `on`. */
  at?: Date;
  /**
   * Calendar-match schedule. `{ hour, minute }` fires daily at that local time
   * and re-arms itself — on Android via the plugin's cron publisher, on iOS via
   * UNCalendarNotificationTrigger(repeats: true).
   *
   * NOTE: do NOT use `{ at, repeats: true }` for a daily reminder. On Android
   * the plugin computes the repeat interval as (at - now), so a reminder saved
   * at 10am for 8am repeats every ~22h and drifts. `on` is the only correct
   * daily schedule.
   */
  on?: { hour?: number; minute?: number };
  allowWhileIdle?: boolean;
}

// Minimal slice of @capacitor/local-notifications we depend on.
interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: PluginPermission }>;
  createChannel(channel: {
    id: string;
    name: string;
    description?: string;
    importance?: 1 | 2 | 3 | 4 | 5;
    visibility?: -1 | 0 | 1;
    vibration?: boolean;
  }): Promise<void>;
  requestPermissions(): Promise<{ display: PluginPermission }>;
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      channelId?: string;
      smallIcon?: string;
      schedule?: ScheduleSpec;
    }>;
  }): Promise<unknown>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  getPending(): Promise<{ notifications: Array<{ id: number }> }>;
}

const LocalNotifications =
  registerPlugin<LocalNotificationsPlugin>("LocalNotifications");

export class CapacitorNotifier implements Notifier {
  private channelReady: Promise<void> | null = null;

  isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Idempotent, and a no-op on iOS where createChannel is unimplemented. */
  private ensureChannel(): Promise<void> {
    if (!this.channelReady) {
      this.channelReady =
        Capacitor.getPlatform() === "android"
          ? LocalNotifications.createChannel({
              id: CHANNEL_ID,
              name: "Daily reminders",
              description: "Your daily verse and thread reminder.",
              importance: 5, // IMPORTANCE_HIGH — heads-up banner + sound
              visibility: 1, // public on the lock screen
              vibration: true,
            }).catch(() => {
              /* older Android / unsupported — fall back to the default channel */
            })
          : Promise.resolve();
    }
    return this.channelReady;
  }

  async permissionStatus(): Promise<PermissionStatus> {
    if (!this.isSupported()) return "unsupported";
    try {
      const { display } = await LocalNotifications.checkPermissions();
      if (display === "granted") return "granted";
      if (display === "denied") return "denied";
      return "prompt";
    } catch {
      return "unsupported";
    }
  }

  async ensurePermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    const current = await LocalNotifications.checkPermissions();
    if (current.display === "granted") return true;
    // 'denied' means the user has turned notifications off at the OS level.
    // Re-requesting is a no-op on Android 13+, so surface it instead.
    if (current.display === "denied") return false;
    const req = await LocalNotifications.requestPermissions();
    return req.display === "granted";
  }

  async scheduleDaily(reminder: DailyReminder): Promise<void> {
    if (!this.isSupported()) return;
    // Replace any existing daily reminder first (schedule is not guaranteed to
    // dedupe by id across app restarts).
    await this.cancelDaily();

    const repeats = reminder.repeats !== false;
    const schedule: ScheduleSpec = repeats
      ? {
          on: { hour: reminder.at.getHours(), minute: reminder.at.getMinutes() },
          allowWhileIdle: true,
        }
      : { at: reminder.at, allowWhileIdle: true };

    await this.ensureChannel();
    await LocalNotifications.schedule({
      notifications: [
        {
          id: reminder.id,
          title: reminder.title,
          body: reminder.body,
          channelId: CHANNEL_ID,
          smallIcon: "ic_stat_ponder",
          schedule,
        },
      ],
    });
  }

  async cancelDaily(): Promise<void> {
    if (!this.isSupported()) return;
    try {
      await LocalNotifications.cancel({
        notifications: [{ id: DAILY_REMINDER_ID }],
      });
    } catch {
      /* nothing pending — cancel is best-effort */
    }
  }

  async sendTest(secondsFromNow = 10): Promise<void> {
    if (!this.isSupported()) throw new Error("Notifications need the installed app");
    const granted = await this.ensurePermission();
    if (!granted) throw new Error("Notifications are turned off for Ponder");
    await this.ensureChannel();
    const at = new Date(Date.now() + secondsFromNow * 1000);
    await LocalNotifications.schedule({
      notifications: [
        {
          id: TEST_NOTIFICATION_ID,
          title: "Ponder",
          body: "Test reminder — your daily verse will arrive like this.",
          channelId: CHANNEL_ID,
          smallIcon: "ic_stat_ponder",
          schedule: { at, allowWhileIdle: true },
        },
      ],
    });
  }

  async pendingIds(): Promise<number[]> {
    if (!this.isSupported()) return [];
    try {
      const { notifications } = await LocalNotifications.getPending();
      return notifications.map((n) => n.id);
    } catch {
      return [];
    }
  }
}
