import { useEffect, useState } from "react";
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
 * No commentary with a phrase. The reader brings the thought.
 *
 * Phrases are verbatim slices of this version's text (see
 * generate-entry/meditation.ts), so the indexOf always lands; if it ever
 * did not, the passage just shows unlit.
 */

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
      <span className={`transition-colors duration-300 ${challenge ? "text-rust" : "text-moss"}`}>
        {phrase}
      </span>
      <span className={dim}>{text.slice(i + phrase.length)}</span>
    </>
  );
}

/** Progress dots, Continue / Done, and a quiet way out. */
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
  return (
    <div className="mt-4">
      <div className="mb-3 flex justify-center gap-1.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${i === at ? fill : challenge ? "bg-rust/20" : "bg-moss/20"}`}
          />
        ))}
      </div>
      <button
        type="button"
        disabled={locked}
        onClick={final ? onClose : onNext}
        className={`pressable min-h-[48px] w-full rounded-2xl text-base font-bold tracking-wide text-paper transition-opacity ${fill} ${
          locked ? "opacity-60" : "opacity-100"
        }`}
      >
        {final ? "Done" : "Continue"}
      </button>
      {!final && (
        <button
          type="button"
          onClick={onClose}
          className="mt-1 w-full py-2.5 text-sm text-muted underline underline-offset-[3px]"
        >
          Close
        </button>
      )}
    </div>
  );
}
