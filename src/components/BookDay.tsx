import { bookLabel, rangeLabel } from "../lib/passageContext";
import type { DailyEntry } from "../lib/types";

/**
 * The parts of the entry card that only a book day has.
 *
 * Progress is POSITION ONLY: where this section sits in the book. Never a day
 * count, never anything about time, never "behind" — the reader moves on by
 * opening what is in front of them, whenever that is.
 */
export function BookProgress({ entry }: { entry: DailyEntry }) {
  const s = entry.book_section!;
  return (
    <div className="mb-5">
      <p className="text-sm font-semibold text-moss">
        {rangeLabel(bookLabel(entry.verse_ref), s)} · passage {s.index} of {s.count}
      </p>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full bg-hairline"
        role="progressbar"
        aria-label={`Passage ${s.index} of ${s.count}`}
        aria-valuemin={1}
        aria-valuemax={s.count}
        aria-valuenow={s.index}
      >
        <div className="h-full rounded-full bg-moss" style={{ width: `${(s.index / s.count) * 100}%` }} />
      </div>
    </div>
  );
}

/** Shown under the last section of the book. */
export function BookEnd({ book, onFinish }: { book: string; onFinish: () => void }) {
  return (
    <section className="mt-10 rounded-2xl border border-hairline bg-surface p-6 text-center">
      <p className="font-display text-2xl font-medium">That’s the end of {book}</p>
      <p className="mt-2 text-base leading-relaxed text-muted">
        When you’re ready, look back over the whole book and close this thread.
        It stays in your journal to read again.
      </p>
      <button
        type="button"
        onClick={onFinish}
        className="pressable mt-5 min-h-[48px] w-full rounded-xl bg-moss py-3 font-semibold text-white"
      >
        Look back and close
      </button>
    </section>
  );
}

/** Previous / Next between the passages of a book thread. Next from today's
 *  passage reads the following one now, and tomorrow carries on from there.
 *  An omitted handler hides that arrow (first or last passage). */
export type PassageNav = {
  busy: boolean;
  error: string;
  onPrevious?: () => void;
  onNext?: () => void;
};

/** A faint arrow either side of the passage name, inside the passage. */
export function NavArrow({ dir, nav }: { dir: "previous" | "next"; nav: PassageNav }) {
  const onClick = dir === "previous" ? nav.onPrevious : nav.onNext;
  return (
    <button
      type="button"
      aria-label={dir === "previous" ? "Previous passage" : "Next passage"}
      disabled={nav.busy || !onClick}
      onClick={onClick}
      // 44px tap area; only the glyph is light. Invisible keeps the name still.
      className="flex h-11 w-11 shrink-0 items-center justify-center text-2xl leading-none text-ink/30 transition-colors hover:text-moss disabled:invisible"
    >
      {dir === "previous" ? "‹" : "›"}
    </button>
  );
}
