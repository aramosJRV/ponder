import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Translation } from "../lib/types";

export type Walk = { phrases: string[]; text: string; translation: Translation };

/**
 * The verse walk (code name "Meditate", never shown to readers): the passage,
 * then one phrase at a time, then the passage again.
 *
 * LIVES WITH THE VERSE, NOT THE QUESTIONS (28 Sep 2026). It first shipped as
 * the opening of the ponder flow, behind "Begin". Antonio moved it up to the
 * verse hero, beside "Read the full context": it is a way of reading the
 * passage, so it sits with the other way of reading the passage, and it is
 * offered every visit rather than once behind the gate.
 *
 * Phrase only — no commentary under it. The reader brings the thought; a
 * line of ours would tell them what to see before they had looked.
 *
 * The passage stays faded above each phrase with that phrase picked out, so
 * the reader never loses where in the verse they are. Phrases are verbatim
 * slices of this version's text (see generate-entry/meditation.ts), so the
 * indexOf always lands; if it ever did not, the passage just shows unmarked.
 *
 * Same 420ms entrance guard as the ponder questions, for the same reason and
 * no other: it stops a double tap eating a phrase. It is not a timer.
 *
 * Portalled to document.body for the reason given in PassageContextSheet:
 * the card's `animate-rise` transform would otherwise capture `fixed`.
 */
export default function VerseWalkSheet({
  walk,
  verseRef,
  challenge,
  onClose,
}: {
  /** Pinned when opened, so a version switch behind the sheet cannot swap it. */
  walk: Walk | null;
  verseRef: string;
  challenge: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!walk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [walk, onClose]);

  useEffect(() => {
    if (!walk) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [walk]);

  if (!walk) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={`${verseRef}, read slowly`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg animate-rise flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-paper px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5 outline-none"
      >
        <Steps walk={walk} verseRef={verseRef} challenge={challenge} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

function Steps({
  walk,
  verseRef,
  challenge,
  onClose,
}: {
  walk: Walk;
  verseRef: string;
  challenge: boolean;
  onClose: () => void;
}) {
  const { phrases, text, translation } = walk;
  const last = phrases.length;
  // -1 = the whole passage, read once; 0..last-1 = one phrase; last = whole again.
  const [at, setAt] = useState(-1);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    setLocked(true);
    const t = setTimeout(() => setLocked(false), 420);
    return () => clearTimeout(t);
  }, [at]);

  const fill = challenge ? "bg-rust" : "bg-moss";
  const line = challenge ? "text-rust" : "text-moss";
  const phrase = at >= 0 && at < last ? phrases[at] : null;

  return (
    <div className="flex min-h-[calc(420px*var(--font-scale))] flex-col">
      <p className="text-xs text-muted">
        {verseRef} · {translation}
      </p>

      {phrase ? (
        <>
          <p className="mt-4 font-display text-base leading-snug text-ink/35">
            <Marked text={text} phrase={phrase} className={line} />
          </p>
          <p
            key={at}
            className="animate-rise my-auto py-8 font-display text-3xl font-medium leading-tight [text-wrap:balance]"
          >
            {phrase[0].toUpperCase() + phrase.slice(1)}
          </p>
          <div className="mb-4 flex justify-center gap-1.5" aria-hidden="true">
            {phrases.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === at ? fill : "bg-hairline"}`}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <p
            key={at}
            className="animate-rise my-auto py-6 font-display text-2xl leading-snug"
          >
            {text}
          </p>
          <p
            className={
              at === -1
                ? "mb-4 text-sm leading-relaxed text-muted"
                : "mb-4 font-display text-xl italic leading-snug text-muted"
            }
          >
            {at === -1
              ? "Read it slowly once. Then we’ll pause on a few of its words, one at a time. Stay with each and notice what it stirs in you."
              : "Now read it once more, whole."}
          </p>
        </>
      )}

      <button
        type="button"
        disabled={locked}
        onClick={() => (at >= last ? onClose() : setAt(at + 1))}
        className={`pressable min-h-[48px] w-full rounded-2xl text-base font-bold tracking-wide text-paper transition-opacity ${fill} ${
          locked ? "opacity-60" : "opacity-100"
        }`}
      >
        {at >= last ? "Done" : "Continue"}
      </button>
      {at < last && (
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full py-2.5 text-sm text-muted underline underline-offset-[3px]"
        >
          Close
        </button>
      )}
    </div>
  );
}

/** `text` with the first occurrence of `phrase` picked out. */
function Marked({ text, phrase, className }: { text: string; phrase: string; className: string }) {
  const i = text.indexOf(phrase);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className={`font-semibold ${className}`}>{phrase}</span>
      {text.slice(i + phrase.length)}
    </>
  );
}
