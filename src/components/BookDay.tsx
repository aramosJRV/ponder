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
 *  passage reads the following one now, and tomorrow carries on from there. */
export function BookNav({ entry, isToday, busy, error, onPrevious, onNext }: {
  entry: DailyEntry;
  isToday: boolean;
  busy: boolean;
  error: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const s = entry.book_section!;
  // Quiet text links: the tap area stays 44px tall, only the look is light.
  const btn = "min-h-[44px] text-sm text-muted transition-colors hover:text-moss disabled:invisible";
  return (
    <div className="mt-3 mb-2">
      <div className="flex justify-between gap-3">
        <button type="button" className={btn} disabled={busy || s.index <= 1} onClick={onPrevious}>
          ‹ Previous
        </button>
        {s.index < s.count && (
          <button type="button" className={btn} disabled={busy} onClick={onNext}>
            {isToday ? "Read the next one ›" : "Next ›"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-muted">{error}</p>}
    </div>
  );
}
