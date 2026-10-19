import { bookLabel, rangeLabel, usePassageContext } from "../lib/passageContext";
import type { DailyEntry, Translation } from "../lib/types";
import { Passage, Unavailable } from "./PassageContextSheet";

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
        {rangeLabel(bookLabel(entry.verse_ref), s)} · section {s.index} of {s.count}
      </p>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full bg-hairline"
        role="progressbar"
        aria-label={`Section ${s.index} of ${s.count}`}
        aria-valuemin={1}
        aria-valuemax={s.count}
        aria-valuenow={s.index}
      >
        <div className="h-full rounded-full bg-moss" style={{ width: `${(s.index / s.count) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * The whole section in the reader's version, key verse highlighted. The
 * section is the pericope the key verse sits in — the same passage the Full
 * passage sheet shows on any other day — so it comes from passage_context
 * and never from anything the writer produced.
 */
export function BookPassage({ entry, translation }: { entry: DailyEntry; translation: Translation }) {
  const state = usePassageContext(entry, translation, true);
  return (
    <section className="mb-8">
      {state.status === "ready" ? (
        <Passage entry={entry} translation={translation} rows={state.rows} />
      ) : state.status === "unavailable" ? (
        <Unavailable kind={state.kind} />
      ) : (
        <p aria-busy="true" className="text-base text-muted">Finding the passage…</p>
      )}
    </section>
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
