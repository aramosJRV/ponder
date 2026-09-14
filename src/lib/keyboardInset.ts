import { useEffect, useState } from "react";
import { Keyboard } from "@capacitor/keyboard";
import { Capacitor } from "@capacitor/core";

/**
 * One source of truth for "how many CSS px of the viewport is the on-screen
 * keyboard currently covering that the platform has NOT already taken off the
 * layout viewport for us".
 *
 * Why this is not just `visualViewport`: shipped in 1.0.8 and it did nothing on
 * Android. Under Android 15 edge-to-edge the IME arrives as a window inset that
 * the WebView does not propagate — `visualViewport.height` never shrinks, so
 * there is nothing to read. The web layer simply cannot see the keyboard.
 * `@capacitor/keyboard` reads the native inset and reports the height, so that
 * is the primary signal; `visualViewport` stays as the fallback for the browser
 * during dev.
 *
 * Two values come out of here and they are NOT the same thing:
 *   --kb      how much the keyboard still covers AFTER the platform resize
 *             (Android: the whole keyboard. iOS: zero — see below.)
 *   .kb-open  the keyboard is on screen at all, whoever absorbed it.
 * Conflating them is what hid the tab bar on one platform and not the other.
 */

/**
 * iOS is a special case and must not be inferred from `window.innerHeight`.
 *
 * capacitor.config.ts sets Keyboard.resize = "native", so CapacitorKeyboard
 * shrinks the WKWebView frame by the full keyboard height — the web layer never
 * needs padding. BUT Keyboard.m applies that frame change on a delayed
 * performSelector (`keyboardAnimationDuration + 0.2`, ~450ms), while the
 * keyboardWillShow / keyboardDidShow JS events fire at ~0ms / ~250ms. So at
 * BOTH events `window.innerHeight` is still the un-shrunk height, `shrunk`
 * reads 0, and --kb was left at the full keyboard height forever (nothing was
 * listening for the late resize). Every consumer then double-counted: the
 * WebView was short by one keyboard AND the sheet was padded by another one,
 * which is what produced the grey band of scrim over the form on iOS only.
 *
 * Deriving this from the platform rather than from a measurement is deliberate:
 * the measurement is not merely late, it is wrong at the only two moments we
 * are told about. If Keyboard.resize in capacitor.config.ts ever stops being
 * "native", this constant has to change with it.
 */
const NATIVE_RESIZE = Capacitor.getPlatform() === "ios";

const ROOT = document.documentElement;

let baselineHeight = window.innerHeight;
let keyboardHeight = 0;
let open = false;
let overlap = 0;
let openFlagged = false;
let started = false;

const listeners = new Set<(px: number) => void>();

function publish() {
  // How much the platform has ALREADY taken off the layout viewport for us.
  const shrunk = Math.max(0, baselineHeight - window.innerHeight);
  const next = !open
    ? 0
    : NATIVE_RESIZE
      ? 0
      : Math.max(0, Math.round(keyboardHeight - shrunk));

  if (open !== openFlagged) {
    openFlagged = open;
    ROOT.classList.toggle("kb-open", open);
  }
  if (next === overlap) return;
  overlap = next;
  ROOT.style.setProperty("--kb", `${overlap}px`);
  listeners.forEach((fn) => fn(overlap));
}

/** Bring the focused field into the part of the screen still visible. */
function revealFocused() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches("input, textarea, [contenteditable]")) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Call once, at app start. Idempotent. */
export function startKeyboardTracking(): void {
  if (started) return;
  started = true;

  if (Capacitor.isPluginAvailable("Keyboard")) {
    void Keyboard.addListener("keyboardWillShow", (info) => {
      keyboardHeight = info.keyboardHeight;
      open = true;
      publish();
    });
    void Keyboard.addListener("keyboardDidShow", (info) => {
      keyboardHeight = info.keyboardHeight;
      open = true;
      publish();
      revealFocused();
    });
    void Keyboard.addListener("keyboardWillHide", () => {
      open = false;
      publish();
    });
    void Keyboard.addListener("keyboardDidHide", () => {
      open = false;
      keyboardHeight = 0;
      publish();
      // Rotation or a system-bar change while typing would otherwise leave a
      // stale baseline; re-take it now that the keyboard is definitely gone.
      baselineHeight = window.innerHeight;
      publish();
    });

    // The platform can resize the viewport LONG after it told us the keyboard
    // was up (iOS: ~450ms; see NATIVE_RESIZE). Without this the overlap is
    // computed once, from a stale innerHeight, and never corrected.
    window.addEventListener("resize", () => {
      if (!open) {
        // Rotation / multitasking while idle — re-baseline, don't treat the
        // change as keyboard absorption.
        baselineHeight = window.innerHeight;
      }
      publish();
      if (open) revealFocused();
    });
    return;
  }

  // Browser fallback (dev). visualViewport does work in desktop/mobile Chrome.
  const vv = window.visualViewport;
  if (!vv) return;
  const read = () => {
    const hidden = window.innerHeight - vv.height - vv.offsetTop;
    open = hidden > 24;
    keyboardHeight = open ? hidden : 0;
    publish();
  };
  read();
  vv.addEventListener("resize", read);
  vv.addEventListener("scroll", read);
}

/** Current keyboard overlap in CSS px, re-rendering on change. */
export function useKeyboardInset(): number {
  const [px, setPx] = useState(overlap);
  useEffect(() => {
    startKeyboardTracking();
    setPx(overlap);
    listeners.add(setPx);
    return () => {
      listeners.delete(setPx);
    };
  }, []);
  return px;
}
