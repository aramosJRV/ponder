/**
 * Whether the reader has already opened the ponder section on a given entry.
 *
 * The gate ("Ready to ponder?") is an invitation, and an invitation you have
 * already accepted should not be issued again. Today unmounts entirely on a
 * tab change (App.tsx renders `{tab === "today" && <Today />}`), and switching
 * threads changes entry.id, so component state alone cannot carry this — it
 * has to outlive the unmount.
 *
 * Three states, not two:
 *
 *   not begun  -> the gate ("Ready to ponder?")
 *   begun      -> question one, gate skipped
 *   done       -> the close screen, all questions listed with their notes
 *
 * Deliberately NOT stored: which question they were on mid-run. Coming back
 * part-way drops you at question one. Restoring a mid-list position means
 * arriving somewhere you have to orient yourself in; question one is a fixed,
 * known place, and every other question is one swipe away.
 *
 * `done` is the exception because it is not a position — it is a different
 * shape of screen. Once you have been through all of them, the thing you came
 * back for is the list (which question was that note on?), not the first
 * question again.
 *
 * localStorage, same as cache.ts. Best-effort: a failure here loses a nicety,
 * never a note.
 */

const KEY = "ponder.progress.v1";
/** Entries stop being revisited long before this; the cap just bounds the blob. */
const TTL_MS = 45 * 24 * 60 * 60 * 1000;

type Row = { begun: boolean; showAll: boolean; done: boolean; at: number };
type Store = Record<string, Row>;

export type PonderProgress = { begun: boolean; showAll: boolean; done: boolean };

const NONE: PonderProgress = { begun: false, showAll: false, done: false };

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function loadPonderProgress(entryId: string): PonderProgress {
  const row = readStore()[entryId];
  if (!row) return NONE;
  // `done` implies `begun` — rows written by the first version of this file
  // have no `done` key at all, and read back as a plain begun row.
  return { begun: !!row.begun || !!row.done, showAll: !!row.showAll, done: !!row.done };
}

export function savePonderProgress(entryId: string, p: PonderProgress): void {
  try {
    const store = readStore();
    const cutoff = Date.now() - TTL_MS;
    for (const [id, row] of Object.entries(store)) {
      if (!row || typeof row.at !== "number" || row.at < cutoff) delete store[id];
    }
    store[entryId] = { begun: p.begun, showAll: p.showAll, done: p.done, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota/private mode — progress is best-effort */
  }
}
