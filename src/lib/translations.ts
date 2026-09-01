/**
 * Bible translation — local mirror of profiles.translation, and the
 * per-passage lookup behind the version tabs on the entry card.
 *
 * Same shape and the same reasons as lib/contentLevel.ts: Today is
 * offline-first and TopicDetail renders entries without ever loading the
 * profile, so the render path reads localStorage and the DB column stays
 * the portable source of truth across a restore. Settings is the only
 * writer of the preference.
 *
 * WHY ONLY THREE: every translation a reader is likely to ask for by name
 * — NIV, ESV, NLT, NASB, CSB, The Message — is copyright-protected. None
 * of them can be stored in bible_verses, copied into
 * daily_entries.verse_text, shared through entry_pool or put in a local
 * notification payload without a commercial licence. WEB, BSB and KJV are
 * public domain and go through the existing pipeline untouched. This list
 * mirrors the bible_translations table; adding a row there without adding
 * it here just means the tab does not appear.
 */

import { useEffect, useRef, useState } from "react";
import { fetchPassageText } from "./api";
import type { DailyEntry, Translation } from "./types";

const KEY = "ponder.translation.v1";
const EVENT = "ponder:translation";

export const DEFAULT_TRANSLATION: Translation = "WEB";

export const TRANSLATIONS: ReadonlyArray<{
  value: Translation;
  /** Tab label. Deliberately the bare code — the tabs sit under the passage
   *  and full names would turn the hero into a menu. */
  label: string;
  name: string;
  blurb: string;
}> = [
  {
    value: "WEB",
    label: "WEB",
    name: "World English Bible",
    blurb: "Modern English, public domain",
  },
  {
    value: "BSB",
    label: "BSB",
    name: "Berean Standard Bible",
    blurb: "Plainest modern reading",
  },
  {
    value: "KJV",
    label: "KJV",
    name: "King James Version",
    blurb: "1611, traditional English",
  },
];

const CODES = TRANSLATIONS.map((t) => t.value);

export function isTranslation(raw: unknown): raw is Translation {
  return typeof raw === "string" && (CODES as string[]).includes(raw);
}

export function translationName(code: Translation): string {
  return TRANSLATIONS.find((t) => t.value === code)?.name ?? code;
}

export function getTranslation(): Translation {
  try {
    const raw = localStorage.getItem(KEY);
    return isTranslation(raw) ? raw : DEFAULT_TRANSLATION;
  } catch {
    return DEFAULT_TRANSLATION;
  }
}

export function setTranslation(code: Translation): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* quota / private mode — the DB row is still authoritative */
  }
  // Same-tab listeners: the native `storage` event only fires cross-document.
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* non-DOM environment */
  }
}

/** Live translation preference. Re-renders when Settings changes it. */
export function useTranslation(): Translation {
  const [code, setCode] = useState<Translation>(getTranslation);
  useEffect(() => {
    const sync = () => setCode(getTranslation());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return code;
}

// ------------------------------------------------------------------ cache
//
// Tabbing is a lookup, not a stored copy: daily_entries.verse_text holds the
// WEB and nothing else, so a non-WEB tab is a round trip. Cache what comes
// back so the second tap — and the same entry opened again tomorrow, or on a
// plane — is instant. Bounded, because localStorage is shared with the
// offline day cache and must never be the thing that fills it.

const CACHE_KEY = "ponder.passages.v1";
const CACHE_LIMIT = 120;

type PassageMap = Record<string, string | null>;

function passageKey(e: PassageCoords, code: Translation): string {
  return `${code}:${e.book_number}:${e.chapter}:${e.verse_start}-${e.verse_end}`;
}

function readCache(): PassageMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as PassageMap) : {};
  } catch {
    return {};
  }
}

function writeCache(map: PassageMap): void {
  try {
    const keys = Object.keys(map);
    // Oldest-first eviction: insertion order is preserved by JSON round-trip
    // for string keys, which is good enough for a display cache.
    const trimmed =
      keys.length <= CACHE_LIMIT
        ? map
        : Object.fromEntries(keys.slice(keys.length - CACHE_LIMIT).map((k) => [k, map[k]]));
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* best-effort */
  }
}

/** Drop every cached passage. Called on sign-out with the rest of local state. */
export function clearPassageCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ------------------------------------------------------------------ hook

export type PassageCoords = Pick<
  DailyEntry,
  "book_number" | "chapter" | "verse_start" | "verse_end"
>;

export type PassageState =
  | { status: "ready"; text: string }
  /** Fetching. `text` is the last text we had, kept on screen so the hero
   *  does not collapse and reflow mid-tap. */
  | { status: "loading"; text: string }
  /** Resolved, and this passage genuinely is not in that translation.
   *  Rare but real: Romans 14:24-26 has no KJV row (the KJV versifies that
   *  doxology as 16:25-27) and fifteen references have no BSB row. */
  | { status: "absent" }
  /** Could not reach the server. Offline is the usual reason. */
  | { status: "unavailable" };

/**
 * Text of one passage in one translation.
 *
 * WEB never goes to the network: the entry already carries it, so the
 * default tab is instant and works with no connection at all. That is the
 * whole reason WEB stays the stored translation.
 */
export function usePassage(
  entry: DailyEntry,
  code: Translation,
): PassageState {
  const [state, setState] = useState<PassageState>(() =>
    code === "WEB" ? { status: "ready", text: entry.verse_text } : { status: "loading", text: entry.verse_text },
  );
  // Keeps the previous text on screen across a tab change instead of
  // blanking the hero while the next one loads.
  const last = useRef(entry.verse_text);

  useEffect(() => {
    if (code === "WEB") {
      last.current = entry.verse_text;
      setState({ status: "ready", text: entry.verse_text });
      return;
    }

    const cached = readCache()[passageKey(entry, code)];
    if (cached !== undefined) {
      if (cached === null) {
        setState({ status: "absent" });
      } else {
        last.current = cached;
        setState({ status: "ready", text: cached });
      }
      return;
    }

    let live = true;
    setState({ status: "loading", text: last.current });
    fetchPassageText(entry, code)
      .then((text) => {
        if (!live) return;
        const map = readCache();
        map[passageKey(entry, code)] = text;
        writeCache(map);
        if (text === null) {
          setState({ status: "absent" });
        } else {
          last.current = text;
          setState({ status: "ready", text });
        }
      })
      .catch(() => {
        // Deliberately NOT cached: a network failure is not evidence about
        // the text, and caching it would make one flaky moment permanent.
        if (live) setState({ status: "unavailable" });
      });

    return () => {
      live = false;
    };
  }, [entry.id, entry.verse_text, entry.book_number, entry.chapter, entry.verse_start, entry.verse_end, code]);

  return state;
}
