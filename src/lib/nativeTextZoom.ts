/**
 * Thin TS face of the Android TextZoom plugin (android/.../TextZoomPlugin.java).
 *
 * Android-only by design — see that file for why there is no iOS half. Every
 * export here no-ops off Android and swallows failures: none of this is worth
 * blocking or breaking app start over, and an older installed build that
 * predates the native plugin must keep working.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface TextZoomPlugin {
  /** The OS font-size multiplier: 1.0 = 100%, 2.0 = Android's ceiling. */
  getSystemFontScale(): Promise<{ scale: number }>;
  /** Force WebView textZoom to 100% so it stops scaling on top of us. */
  pin(): Promise<void>;
}

const TextZoom = registerPlugin<TextZoomPlugin>("TextZoom");

function isAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

/**
 * Stop Android's WebView applying the system font scale on top of
 * --font-scale. Call once at boot, before anything measures the layout.
 * Returns whether the pin actually happened.
 */
export async function pinWebViewTextZoom(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    await TextZoom.pin();
    return true;
  } catch {
    // Plugin missing (build predates it) or the bridge is not up. The app is
    // still usable — it just scales twice on Android until the next build.
    return false;
  }
}

/**
 * The OS font-size multiplier, or null when unavailable (iOS, web, or an
 * older build). Only meaningful as a first-run seed.
 */
export async function systemFontScale(): Promise<number | null> {
  if (!isAndroid()) return null;
  try {
    const { scale } = await TextZoom.getSystemFontScale();
    return Number.isFinite(scale) && scale > 0 ? scale : null;
  } catch {
    return null;
  }
}
