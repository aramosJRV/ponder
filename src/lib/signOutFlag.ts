import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * "Just signed out" flag.
 *
 * Signing out drops the session, and the next boot mints a fresh anonymous
 * session the same way a genuine first launch does (see ensureSession() in
 * supabase.ts). Without this flag, that boot looks identical to a brand new
 * install: the user lands on an empty Today/Topics view with no hint that
 * their real journal is one restore code away. We set this right before
 * signing out; App.tsx consumes it on the next successful boot to route
 * straight into the restore flow instead.
 */
const KEY = "ponder.justSignedOut.v1";
const isNative = Capacitor.isNativePlatform();

export async function markSignedOut(): Promise<void> {
  if (isNative) {
    await Preferences.set({ key: KEY, value: "1" });
    return;
  }
  globalThis.localStorage?.setItem(KEY, "1");
}

/** Reads the flag and clears it in the same call, so the restore detour only
 * happens once per sign-out, not on every subsequent app open. */
export async function consumeSignedOutFlag(): Promise<boolean> {
  const wasSet = isNative
    ? (await Preferences.get({ key: KEY })).value === "1"
    : globalThis.localStorage?.getItem(KEY) === "1";
  if (wasSet) {
    if (isNative) await Preferences.remove({ key: KEY });
    else globalThis.localStorage?.removeItem(KEY);
  }
  return Boolean(wasSet);
}
