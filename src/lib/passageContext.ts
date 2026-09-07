import { useEffect, useRef, useState } from "react";
import { fetchPassageContext } from "./api";
import { classifyError, type ErrorKind } from "./errors";
import type { DailyEntry, PassageContextRow, Translation } from "./types";

/**
 * "Read the full context" — the passage around the day's verse.
 *
 * The unit is the pericope, not the chapter, and it is chosen by the server
 * from the verse alone. It is NOT narrowed to the part that suits the reader's
 * thread: context filtered for topical relevance is proof-texting with extra
 * steps, and it would trim exactly the verses that challenge the framing the
 * reader arrived with. Two people on the same verse see the same passage.
 *
 * Unlike the version tabs, this ALWAYS needs the network. daily_entries
 * carries the day's own verse and nothing either side of it, so there is no
 * offline path — the sheet says so rather than pretending.
 */

// ------------------------------------------------------------------ cache
//
// Own key and a smaller limit than the passage cache: a context read is ten
// to twenty verses where a hero is one or two, so the same number of entries
// would be an order of magnitude more localStorage. This shares space with
// the offline day cache and must never be what fills it.

const CACHE_KEY = "ponder.context.v1";
const CACHE_LIMIT = 30;

type ContextMap = Record<string, PassageContextRow[]>;

export type ContextCoords = Pick<DailyEntry, "book_number" | "chapter" | "verse_start">;

function contextKey(c: ContextCoords, code: Translation): string {
  return `${code}:${c.book_number}:${c.chapter}:${c.verse_start}`;
}

function readCache(): ContextMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ContextMap) : {};
  } catch {
    return {};
  }
}

function writeCache(map: ContextMap): void {
  try {
    const keys = Object.keys(map);
    const trimmed =
      keys.length <= CACHE_LIMIT
        ? map
        : Object.fromEntries(keys.slice(keys.length - CACHE_LIMIT).map((k) => [k, map[k]]));
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* best-effort */
  }
}

/** Drop every cached context passage.
 *
 *  NOTE: nothing calls this yet — and nothing calls clearPassageCache()
 *  either, despite its comment saying otherwise. Sign-out currently leaves
 *  both caches on the device. Wire them together when that is fixed. */
export function clearContextCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ------------------------------------------------------------------ hook

export type ContextState =
  /** Not asked for yet. The sheet has never been opened for this entry. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rows: PassageContextRow[] }
  /** Could not reach the server. `kind` drives which copy the sheet shows —
   *  "you're offline" and "something broke" are different apologies. */
  | { status: "unavailable"; kind: ErrorKind };

/**
 * Rows for the context sheet. Fetches only once `enabled` is true, so opening
 * the card costs nothing — the reader has to ask for the context.
 */
export function usePassageContext(
  entry: DailyEntry,
  code: Translation,
  enabled: boolean,
): ContextState {
  const [state, setState] = useState<ContextState>({ status: "idle" });
  // Keeps a failed retry from flashing back through "idle" between attempts.
  const asked = useRef(false);

  useEffect(() => {
    if (!enabled) {
      asked.current = false;
      setState({ status: "idle" });
      return;
    }

    const key = contextKey(entry, code);
    const cached = readCache()[key];
    if (cached) {
      setState({ status: "ready", rows: cached });
      return;
    }

    let live = true;
    asked.current = true;
    setState({ status: "loading" });
    fetchPassageContext(entry, code)
      .then((rows) => {
        if (!live) return;
        if (!rows.length) {
          // pericope_for is total, so an empty result means the pericope
          // table is not loaded — a deployment problem, not a data one.
          setState({ status: "unavailable", kind: "server" });
          return;
        }
        const map = readCache();
        map[key] = rows;
        writeCache(map);
        setState({ status: "ready", rows });
      })
      .catch((e) => {
        // Not cached: a network failure says nothing about the passage, and
        // caching it would make one flaky moment permanent.
        if (live) setState({ status: "unavailable", kind: classifyError(e).kind });
      });

    return () => {
      live = false;
    };
  }, [enabled, entry.book_number, entry.chapter, entry.verse_start, code]);

  return state;
}

// ------------------------------------------------------------------ labels

/**
 * The book name, taken off the entry's own display reference.
 *
 * `verse_ref` is written server-side as "Psalm 46:10" or "Psalm 46:10-11", so
 * stripping the trailing chapter:verse leaves the book. Deriving it here
 * rather than adding a column keeps one source of truth for how a book is
 * named on screen.
 */
export function bookLabel(verseRef: string): string {
  return verseRef.replace(/\s+\d+:\d+(\s*[-–]\s*\d+)?\s*$/, "").trim();
}

/**
 * "Psalm 46:1–11", or "1 Corinthians 12:31–13:13" when the unit crosses a
 * chapter — which is the case this whole feature exists for, so the label
 * must show it rather than flattening to a chapter number.
 */
export function rangeLabel(book: string, row: PassageContextRow): string {
  const { start_chapter, start_verse, end_chapter, end_verse } = row;
  if (start_chapter === end_chapter && start_verse === end_verse) {
    return `${book} ${start_chapter}:${start_verse}`;
  }
  return start_chapter === end_chapter
    ? `${book} ${start_chapter}:${start_verse}–${end_verse}`
    : `${book} ${start_chapter}:${start_verse}–${end_chapter}:${end_verse}`;
}
