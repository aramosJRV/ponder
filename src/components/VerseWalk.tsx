import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { Translation } from "../lib/types";

export type Walk = { phrases: string[]; text: string; translation: Translation };

/**
 * The verse walk (code name "Meditate", never shown to readers): the
 * passage, with one phrase at a time picked out.
 *
 * WHERE IT LIVES. It first shipped as the opening of the ponder flow (26 Sep
 * 2026). On 28 Sep Antonio moved it to the verse hero, opened by "Read it
 * slowly" beside "Read the full context": it is a way of reading the
 * passage, so it sits with the other way of reading the passage, and it is
 * offered every visit rather than once behind the ponder gate.
 *
 * IN PLACE, AT FULL SIZE. The same day it went from a bottom sheet (faded
 * small passage above a large phrase) to the hero itself: the passage stays
 * exactly where and how big it was, and the phrase is lit within it while
 * the rest dims. In the sheet the passage was too small to read, and the
 * reader lost the page they had just been reading.
 *
 * CONTINUE STAYS IN REACH. On 29 Sep the controls moved out of the page flow
 * into a bar pinned just above the tab bar. In the hero they sat under the
 * reference line, which on a long passage (Romans 8:35-39 at full size) is
 * below the fold, so every step meant scroll down, tap, scroll back up. The
 * page now also follows the lit phrase (useFollowPhrase), so the reader
 * never scrolls by hand during a walk.
 *
 * No commentary with a phrase. The reader brings the thought.
 *
 * Phrases are verbatim slices of this version's text (see
 * generate-entry/meditation.ts), so the indexOf always lands; if it ever
 * did not, the passage just shows unlit.
 */

/**
 * The phrases in the order they appear in the passage, so the walk reads
 * start to finish and never jumps ahead then back. Until 29 Sep the model
 * was told to open on "the weightiest word in the passage", which was often
 * near the end, and the walk followed its order. A phrase and the wider
 * phrase that starts with it ("Trust", "Trust in the LORD") share a start;
 * the shorter comes first so the walk still widens.
 */
export function inReadingOrder(phrases: string[], text: string): string[] {
  const at = (p: string) => {
    const i = text.indexOf(p);
    return i < 0 ? Infinity : i;
  };
  return [...phrases].sort((a, b) => at(a) - at(b) || a.length - b.length);
}

/** Steps through a walk. Resets whenever a new walk starts. */
export function useWalkStep(walk: Walk | null) {
  const [at, setAt] = useState(0);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    setAt(0);
  }, [walk]);

  // Same 420ms guard as the ponder questions, for the same reason and no
  // other: it stops a double tap eating a phrase. It is not a timer.
  useEffect(() => {
    setLocked(true);
    const t = setTimeout(() => setLocked(false), 420);
    return () => clearTimeout(t);
  }, [at, walk]);

  return { at, locked, next: () => setAt((i) => i + 1) };
}

/**
 * Keeps the lit phrase on screen: when a step lands on a phrase that is off
 * screen or tucked under the pinned bar, scroll it to about a third of the
 * way down. A phrase already comfortably in view does not move the page.
 */
export function useFollowPhrase(
  container: RefObject<HTMLElement>,
  at: number,
  walk: Walk | null,
) {
  useEffect(() => {
    if (!walk) return;
    const lit = container.current?.querySelector<HTMLElement>("[data-walk-lit]");
    if (!lit) return;
    const bar = document.querySelector<HTMLElement>("[data-walk-bar]");
    const top = 24;
    const bottom = (bar ? bar.getBoundingClientRect().top : window.innerHeight) - 16;
    const r = lit.getBoundingClientRect();
    if (r.top >= top && r.bottom <= bottom) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({
      top: r.top - (top + (bottom - top) * 0.3),
      behavior: reduce ? "auto" : "smooth",
    });
  }, [container, at, walk]);
}

/** The passage with `phrase` lit and everything else dimmed. */
export function WalkText({
  text,
  phrase,
  challenge,
}: {
  text: string;
  phrase: string;
  challenge: boolean;
}) {
  const i = text.indexOf(phrase);
  if (i < 0) return <>{text}</>;
  const dim = "text-ink/30 transition-colors duration-300";
  return (
    <>
      <span className={dim}>{text.slice(0, i)}</span>
      <span
        data-walk-lit
        className={`transition-colors duration-300 ${challenge ? "text-rust" : "text-moss"}`}
      >
        {phrase}
      </span>
      <span className={dim}>{text.slice(i + phrase.length)}</span>
    </>
  );
}

/**
 * Progress dots, Continue / Done, and a quiet way out, in a bar pinned just
 * above the tab bar (56px tall plus the home-indicator inset) for as long
 * as the walk is open.
 *
 * Portalled to <body>: the entry card's `animate-rise` leaves a transform on
 * the <article>, and a transformed ancestor makes `position: fixed` pin to
 * that ancestor instead of the screen, which put the bar at the bottom of
 * the card, below the fold again.
 */
export function WalkControls({
  total,
  at,
  locked,
  challenge,
  onNext,
  onClose,
}: {
  total: number;
  at: number;
  locked: boolean;
  challenge: boolean;
  onNext: () => void;
  onClose: () => void;
}) {
  const final = at >= total - 1;
  const fill = challenge ? "bg-rust" : "bg-moss";
  return createPortal(
    <div
      data-walk-bar
      className="hide-when-keyboard fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-20 border-t border-hairline bg-paper/95 shadow-[0_-6px_16px_rgba(31,27,22,0.06)] backdrop-blur"
    >
      <div className="mx-auto max-w-lg px-6 pb-3 pt-2.5">
        <div className="mb-2.5 flex justify-center gap-1.5" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i === at ? fill : challenge ? "bg-rust/20" : "bg-moss/20"}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={locked}
            onClick={final ? onClose : onNext}
            className={`pressable min-h-[48px] flex-1 rounded-2xl text-base font-bold tracking-wide text-paper transition-opacity ${fill} ${
              locked ? "opacity-60" : "opacity-100"
            }`}
          >
            {final ? "Done" : "Continue"}
          </button>
          {!final && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="pressable flex h-12 w-12 flex-none items-center justify-center rounded-full border border-hairline bg-paper text-xl leading-none text-muted"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
