/**
 * Content level — local mirror of profiles.content_level.
 *
 * Why localStorage and not a prop threaded down from a fetch:
 * Today is offline-first (see lib/cache.ts) and TopicDetail renders entries
 * without ever loading the profile. Making EntryCard depend on a profile
 * fetch would add a round trip to both screens and leave the card blank —
 * or wrong — when the device is offline. The DB column stays the portable
 * source of truth across a restore; this is the read path.
 *
 * Settings is the only writer. It reconciles on load (DB wins) and writes
 * both on change.
 */

import { useEffect, useState } from "react";
import type { ContentLevel } from "./types";

const KEY = "ponder.contentLevel.v1";
const EVENT = "ponder:contentlevel";

export const DEFAULT_CONTENT_LEVEL: ContentLevel = 3;

export const CONTENT_LEVELS: ReadonlyArray<{
  value: ContentLevel;
  label: string;
  detail: string;
}> = [
  { value: 1, label: "Brief", detail: "Passage and questions" },
  { value: 2, label: "Fuller", detail: "Adds the thought" },
  { value: 3, label: "Full", detail: "Adds illustration and prayer" },
];

function coerce(raw: unknown): ContentLevel {
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 ? n : DEFAULT_CONTENT_LEVEL;
}

export function getContentLevel(): ContentLevel {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_CONTENT_LEVEL : coerce(raw);
  } catch {
    return DEFAULT_CONTENT_LEVEL;
  }
}

export function setContentLevel(level: ContentLevel): void {
  try {
    localStorage.setItem(KEY, String(level));
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

/** Live content level. Re-renders when Settings changes it. */
export function useContentLevel(): ContentLevel {
  const [level, setLevel] = useState<ContentLevel>(getContentLevel);
  useEffect(() => {
    const sync = () => setLevel(getContentLevel());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return level;
}
