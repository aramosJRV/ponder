import { useEffect, useState } from "react";

/**
 * Height in CSS px that the on-screen keyboard currently covers at the bottom
 * of the layout viewport.
 *
 * We do NOT use @capacitor/keyboard for this. Without that plugin iOS never
 * resizes the WKWebView, and on Android 15+ (edge-to-edge, see
 * capacitor.config.ts) the window pans instead of resizing — so neither
 * `100dvh` nor `position: fixed` shrink when the keyboard appears, and a
 * bottom-anchored sheet ends up underneath it.
 *
 * visualViewport reports the truth on both platforms:
 *   - resize mode: offsetTop stays 0, height shrinks by the keyboard height
 *   - pan mode:    offsetTop is the pan amount, so (innerHeight - height -
 *                  offsetTop) is what is still hidden *in layout coordinates*,
 *                  which is exactly what a `position: fixed` element needs.
 * Returns 0 on desktop/browser where there is no keyboard.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      // sub-pixel noise and rubber-banding produce small negatives/positives
      setInset(hidden > 24 ? Math.round(hidden) : 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}

/**
 * onFocus handler for fields inside a scrollable sheet: once the keyboard has
 * settled, bring the focused field into the still-visible area. WKWebView's
 * own scroll-into-view does nothing for `position: fixed` containers.
 */
export function scrollFieldIntoView(e: React.FocusEvent<HTMLElement>) {
  const el = e.currentTarget;
  window.setTimeout(() => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 300);
}
