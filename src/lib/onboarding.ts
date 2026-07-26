import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/**
 * First-run onboarding flag.
 *
 * There is no sign-up screen (anonymous auth), so "have we shown onboarding?"
 * can't be inferred from an account. We persist a small flag instead: native
 * builds use @capacitor/preferences (survives WebView storage eviction), web
 * falls back to localStorage. Mirrors the storage strategy in authStorage.ts.
 */
const KEY = "promptings.onboarded.v1";
const isNative = Capacitor.isNativePlatform();

export async function hasOnboarded(): Promise<boolean> {
  if (isNative) {
    const { value } = await Preferences.get({ key: KEY });
    return value === "1";
  }
  return globalThis.localStorage?.getItem(KEY) === "1";
}

export async function markOnboarded(): Promise<void> {
  if (isNative) {
    await Preferences.set({ key: KEY, value: "1" });
    return;
  }
  globalThis.localStorage?.setItem(KEY, "1");
}

/** Escape hatch for testing the flow again (e.g. from a dev/settings action). */
export async function resetOnboarding(): Promise<void> {
  if (isNative) {
    await Preferences.remove({ key: KEY });
    return;
  }
  globalThis.localStorage?.removeItem(KEY);
}
