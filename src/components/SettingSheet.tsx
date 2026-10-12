import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchVerseSetting } from "../lib/api";
import { classifyError, errorCopy, type ErrorKind } from "../lib/errors";
import { bookLabel } from "../lib/passageContext";
import type { DailyEntry, VerseSetting } from "../lib/types";

/**
 * "The setting" — who wrote the passage, who first heard it, what was
 * happening. Background only: it never says what the verse means, and like
 * "Read the full context" it is the same for every reader on that verse.
 *
 * Same sheet shell as PassageContextSheet, and portalled for the same reason
 * (EntryCard's `animate-rise` transform would otherwise capture
 * `position: fixed`). See the comments there before changing the shell.
 */
type State =
  | { status: "loading" }
  | { status: "ready"; setting: VerseSetting }
  | { status: "unavailable"; kind: ErrorKind };

export default function SettingSheet({
  entry,
  open,
  onClose,
}: {
  entry: DailyEntry;
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const dialogRef = useRef<HTMLDivElement>(null);

  // A network read on each open. It's a handful of sentences — not worth a cache.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ status: "loading" });
    fetchVerseSetting(entry)
      .then((setting) => {
        if (!live) return;
        // No row means the book's setting isn't loaded — a deployment gap.
        setState(setting ? { status: "ready", setting } : { status: "unavailable", kind: "server" });
      })
      .catch((e) => {
        if (live) setState({ status: "unavailable", kind: classifyError(e).kind });
      });
    return () => {
      live = false;
    };
  }, [open, entry.book_number, entry.chapter, entry.verse_start]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const book = bookLabel(entry.verse_ref);

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
        aria-label={`The setting of ${book}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg animate-rise flex-col rounded-t-3xl bg-paper outline-none"
      >
        <header className="shrink-0 border-b border-hairline px-6 pb-4 pt-5">
          <h2 className="font-display text-xl font-medium">{book}</h2>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            The setting
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {state.status === "loading" && (
            <p aria-busy="true" className="text-base text-muted">
              Finding the setting…
            </p>
          )}

          {state.status === "unavailable" && (
            <div>
              <p className="font-display text-lg font-medium">{errorCopy(state.kind).title}</p>
              <p className="mt-1.5 text-base leading-relaxed text-muted">
                {errorCopy(state.kind).body}
              </p>
            </div>
          )}

          {state.status === "ready" && (
            <div className="space-y-5">
              {state.setting.note && (
                <p className="rounded-2xl bg-moss-soft px-4 py-3 text-body leading-relaxed">
                  {state.setting.note}
                </p>
              )}
              <Section title="Who wrote it" body={state.setting.author} />
              <Section title="Who first heard it" body={state.setting.audience} />
              <Section title="What was happening" body={state.setting.era} />
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-hairline px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={onClose}
            className="pressable min-h-[48px] w-full rounded-2xl border border-hairline bg-surface text-base font-semibold text-ink"
          >
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-[0.18em] text-muted">{title}</h3>
      <p className="text-body leading-relaxed">{body}</p>
    </section>
  );
}
