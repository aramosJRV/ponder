/**
 * Text scale — local mirror of profiles.text_scale, and the only writer of the
 * --font-scale CSS variable.
 *
 * Same shape and the same reasons as lib/contentLevel.ts: Today is
 * offline-first and TopicDetail never loads the profile, so a profile fetch
 * here would add a round trip to both screens and render at the wrong size
 * while offline. The DB column is the portable source of truth across a
 * restore; this is the read path. Settings is the only writer.
 *
 * What makes this one different from contentLevel: it has a side effect on the
 * document. tailwind.config.js expresses the whole type scale — and a few
 * coupled geometry values in PonderFlow — as calc(<n>px * var(--font-scale)),
 * so setting that variable is what actually resizes the app. Nothing else may
 * set it.
 *
 * Stored as a percent (100/140/200) to match the smallint column; the CSS
 * variable is the unitless multiplier, i.e. percent / 100.
 */

import { useEffect, useState } from "react";
import type { TextScale } from "./types";

const KEY = "ponder.textScale.v1";
const EVENT = "ponder:textscale";
const CSS_VAR = "--font-scale";

export const DEFAULT_TEXT_SCALE: TextScale = 100;

export const TEXT_SCALES: ReadonlyArray<{
  value: TextScale;
  label: string;
  detail: string;
}> = [
  { value: 100, label: "Default", detail: "The size Ponder has always been" },
  { value: 140, label: "Comfortable", detail: "Noticeably larger" },
  { value: 200, label: "Large", detail: "As large as your phone allows" },
];

function coerce(raw: unknown): TextScale {
  const n = Number(raw);
  return n === 100 || n === 140 || n === 200 ? n : DEFAULT_TEXT_SCALE;
}

const SEEDED_KEY = "ponder.textScale.seeded.v1";

/**
 * Nearest rung to an arbitrary OS multiplier. Nearest, not floor: a reader on
 * 150% is better served by 140 than by 100, and the rungs are far enough apart
 * that rounding down would throw away most of what they asked Android for.
 */
export function nearestRung(multiplier: number): TextScale {
  const pct = multiplier * 100;
  let best: TextScale = DEFAULT_TEXT_SCALE;
  for (const opt of TEXT_SCALES) {
    if (Math.abs(opt.value - pct) < Math.abs(best - pct)) best = opt.value;
  }
  return best;
}

/**
 * Has the one-time OS seed already run on this install?
 *
 * A flag, not "is the column still at its default" (the trick
 * ensureDeviceTimezone uses): Default is a perfectly normal thing to choose
 * here, and the default-value test would silently re-seed over that choice on
 * the next launch.
 */
export function textScaleSeeded(): boolean {
  try {
    return localStorage.getItem(SEEDED_KEY) === "1";
  } catch {
    // No storage means we cannot prove it has not run. Claim it has: a
    // repeated seed would overwrite a real choice, which is worse than never
    // seeding at all.
    return true;
  }
}

export function markTextScaleSeeded(): void {
  try {
    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    /* quota / private mode */
  }
}

export function getTextScale(): TextScale {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_TEXT_SCALE : coerce(raw);
  } catch {
    return DEFAULT_TEXT_SCALE;
  }
}

/** Write the multiplier to the document. The only place that touches it. */
function applyToDocument(scale: TextScale): void {
  try {
    document.documentElement.style.setProperty(CSS_VAR, String(scale / 100));
  } catch {
    /* non-DOM environment (tests) — the stylesheet default of 1 stands */
  }
}

/**
 * Apply the stored scale to the document.
 *
 * Call this from main.tsx BEFORE the first render. If it ran inside a
 * component effect the app would paint once at 1x and then jump, which on the
 * largest step is a full relayout in front of the reader.
 */
export function initTextScale(): void {
  applyToDocument(getTextScale());
}

export function setTextScale(scale: TextScale): void {
  try {
    localStorage.setItem(KEY, String(scale));
  } catch {
    /* quota / private mode — the DB row is still authoritative */
  }
  applyToDocument(scale);
  // Same-tab listeners: the native `storage` event only fires cross-document.
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* non-DOM environment */
  }
}

/** Live text scale. Re-renders when Settings changes it. */
export function useTextScale(): TextScale {
  const [scale, setScale] = useState<TextScale>(getTextScale);
  useEffect(() => {
    const sync = () => setScale(getTextScale());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return scale;
}
