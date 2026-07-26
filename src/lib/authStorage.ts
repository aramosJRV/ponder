import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * Storage adapter for the Supabase auth session.
 *
 * Why this exists: with anonymous auth there is no email/password to sign back
 * in with, so the *only* proof of account ownership is the persisted session.
 * Supabase defaults to localStorage, which a Capacitor WebView can evict under
 * storage pressure — that would silently orphan the account and every topic,
 * note and entry attached to it. @capacitor/preferences persists to native
 * UserDefaults (iOS) / SharedPreferences (Android), which the OS does not clear.
 *
 * On web (dev / browser build) there is no native layer, so we fall back to
 * localStorage. The interface matches what supabase-js expects (get/set/remove).
 */
const isNative = Capacitor.isNativePlatform();

export const authStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isNative) {
      const { value } = await Preferences.get({ key });
      return value ?? null;
    }
    return globalThis.localStorage?.getItem(key) ?? null;
  },

  async setItem(key: string, value: string): Promise<void> {
    if (isNative) {
      await Preferences.set({ key, value });
      return;
    }
    globalThis.localStorage?.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (isNative) {
      await Preferences.remove({ key });
      return;
    }
    globalThis.localStorage?.removeItem(key);
  },
};
