import { useEffect, useRef } from "react";
import { errorCopy } from "../lib/errors";
import { bookLabel, rangeLabel, usePassageContext } from "../lib/passageContext";
import { translationName } from "../lib/translations";
import type { DailyEntry, Translation } from "../lib/types";

/**
 * "Read the full context" — the day's verse inside its literary unit.
 *
 * Two decisions worth not re-litigating:
 *
 * NO SECTION HEADING. The sheet is titled with the reference only ("Psalm
 * 46:1–11"), never an editorial label like "God is our refuge". A heading is
 * someone's summary of what a passage means, and handing the reader that
 * summary is the opposite of showing them the passage. The reference tells
 * them where they are; the text tells them the rest.
 *
 * THE WHOLE UNIT, NOT THE RELEVANT PART. The passage is not trimmed to the
 * verses that suit the thread. That was the original idea for this feature
 * and it was rejected: context selected for topical relevance cuts exactly
 * the verses that would challenge the reader's framing.
 */
export default function PassageContextSheet({
  entry,
  translation,
  open,
  onClose,
}: {
  entry: DailyEntry;
  translation: Translation;
  open: boolean;
  onClose: () => void;
}) {
  const state = usePassageContext(entry, translation, open);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes. A sheet with no keyboard exit is a trap for anyone on an
  // external keyboard, which on iPad is not unusual.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const book = bookLabel(entry.verse_ref);
  const heading = state.status === "ready" ? rangeLabel(book, state.rows[0]) : book;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${heading}, the passage around today's verse`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg animate-rise flex-col rounded-t-3xl bg-paper"
      >
        <header className="shrink-0 border-b border-hairline px-6 pb-4 pt-5">
          <h2 className="font-display text-xl font-medium">{heading}</h2>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            {translationName(translation)}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {state.status === "loading" && (
            <p aria-busy="true" className="text-[15px] text-muted">
              Finding the passage…
            </p>
          )}

          {state.status === "unavailable" && <Unavailable kind={state.kind} />}

          {state.status === "ready" && (
            <Passage entry={entry} translation={translation} rows={state.rows} />
          )}
        </div>

        <footer className="shrink-0 border-t border-hairline px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="pressable min-h-[48px] w-full rounded-2xl border border-hairline bg-surface text-base font-semibold text-ink"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The passage itself.
 *
 * Verses run as continuous prose with small numbers rather than one line per
 * verse: the verse-per-line layout is a study-Bible convention that makes a
 * paragraph look like a list of separate claims, which is the reading habit
 * this feature is trying to loosen.
 */
function Passage({
  entry,
  translation,
  rows,
}: {
  entry: DailyEntry;
  translation: Translation;
  rows: import("../lib/types").PassageContextRow[];
}) {
  // The day's verse, marked so the reader keeps their place. daily_entries
  // stores a single chapter, so the focus span never crosses one.
  const isFocus = (chapter: number, verse: number) =>
    chapter === entry.chapter && verse >= entry.verse_start && verse <= entry.verse_end;

  let lastChapter = rows[0].chapter;

  return (
    <div className="text-[17px] leading-[1.75]">
      {rows.map((r, i) => {
        // A chapter number appears mid-passage only when the unit crosses a
        // break — the reader should be able to see that it did.
        const crossed = r.chapter !== lastChapter;
        lastChapter = r.chapter;
        const focus = isFocus(r.chapter, r.verse);

        return (
          <span key={`${r.chapter}:${r.verse}`}>
            {crossed && (
              <span className="mx-1 align-baseline text-[13px] font-bold text-moss">
                {r.chapter}
              </span>
            )}
            <span
              className={
                focus
                  ? "rounded bg-moss-soft px-0.5 py-0.5 font-medium text-ink"
                  : undefined
              }
            >
              <sup className="mr-0.5 align-super text-[11px] font-bold text-muted">
                {r.verse}
              </sup>
              {r.verse_text ?? (
                <em className="text-muted">
                  [not in the {translationName(translation)}]
                </em>
              )}
            </span>
            {i < rows.length - 1 ? " " : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Always a network read, so offline is the common case here rather than an
 * edge one. Say which failure it was — "you're offline" and "the server
 * broke" want different responses from the reader.
 */
function Unavailable({ kind }: { kind: import("../lib/errors").ErrorKind }) {
  const copy = errorCopy(kind);
  return (
    <div>
      <p className="font-display text-lg font-medium">{copy.title}</p>
      <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{copy.body}</p>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        Today’s verse is still on the card behind this — it’s stored with the
        entry. The verses around it aren’t.
      </p>
    </div>
  );
}
