import { useEffect, useState } from "react";
import { Keyboard } from "@capacitor/keyboard";
import { Capacitor } from "@capacitor/core";

/**
 * One source of truth for "how many CSS px of the viewport is the on-screen
 * keyboard currently covering".
 *
 * Why this is not just `visualViewport`: shipped in 1.0.8 and it did nothing on
 * Android. Under Android 15 edge-to-edge the IME arrives as a window inset that
 * the WebView does not propagate — `visualViewport.height` never shrinks, so
 * there is nothing to read. The web layer simply cannot see the keyboard.
 * `@capacitor/keyboard` reads the native inset and reports the height, so that
 * is the primary signal; `visualViewport` stays as the fallback for the browser
 * during dev.
 *
 * The overlap is `keyboardHeight − howMuchTheWindowAlreadyShrank`, so this is
 * correct whether the platform resizes the WebView (iOS with resize:'native',
 * Android with adjustResize → overlap 0, layout already correct) or leaves it
 * full-height (→ overlap is the whole keyboard). Never double-counts.
 */

const ROOT = document.documentElement;

let baselineHeight = window.innerHeight;
let keyboardHeight = 0;
let open = false;
let overlap = 0;
let started = false;

const listeners = new Set<(px: number) => void>();

function publish() {
  // How much the platform has ALREADY taken off the layout viewport for us.
  const shrunk = Math.max(0, baselineHeight - window.innerHeight);
  const next = open ? Math.max(0, Math.round(keyboardHeight - shrunk)) : 0;
  if (next === overlap) return;
  overlap = next;
  ROOT.style.setProperty("--kb", `${overlap}px`);
  ROOT.classList.toggle("kb-open", overlap > 0);
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
