// Capacitor Local Notifications implementation of Notifier.
//
// The plugin is accessed via registerPlugin() from @capacitor/core (already a
// dependency) rather than a direct import of @capacitor/local-notifications, so
// the web build compiles without the native package present. The native package
// still must be installed and `npx cap sync`'d for on-device delivery:
//   npm install @capacitor/local-notifications
//   npx cap sync

import { Capacitor, registerPlugin } from "@capacitor/core";
import { DAILY_REMINDER_ID, type DailyReminder, type Notifier } from "./types";

type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

// Minimal slice of @capacitor/local-notifications we depend on.
interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: PermissionState }>;
  requestPermissions(): Promise<{ display: PermissionState }>;
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      schedule?: { at?: Date; allowWhileIdle?: boolean };
    }>;
  }): Promise<unknown>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
}

const LocalNotifications =
  registerPlugin<LocalNotificationsPlugin>("LocalNotifications");

export class CapacitorNotifier implements Notifier {
  isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  async ensurePermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    const current = await LocalNotifications.checkPermissions();
    if (current.display === "granted") return true;
    if (current.display === "denied") return false;
    const req = await LocalNotifications.requestPermissions();
    return req.display === "granted";
  }

  async scheduleDaily(reminder: DailyReminder): Promise<void> {
    if (!this.isSupported()) return;
    // Replace any existing daily reminder first (schedule is not guaranteed to
    // dedupe by id across app restarts).
    await this.cancelDaily();
    await LocalNotifications.schedule({
      notifications: [
        {
          id: reminder.id,
          title: reminder.title,
          body: reminder.body,
          schedule: { at: reminder.at, allowWhileIdle: true },
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
}
