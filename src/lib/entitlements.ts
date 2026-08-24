// Client-side app limits.
//
// Ponder is free and there are no tiers. Nothing in this file gates access to
// anything, and nothing here varies by whether a user has contributed —
// contributing unlocks nothing, by design.
//
// What remains is one constant for the thread cap, plus the RevenueCat
// entitlement state, which is still tracked because the SDK reports it and the
// webhook still writes it. No code path reads it to decide what a user may do.
// The app's actual rules are enforced in the edge functions
// (synthesis_allowed), which refuse regardless of what this file believes.

import {
  readEntitlement,
  billingAvailable,
  NO_ENTITLEMENT,
  type EntitlementState,
} from "./billing";

/**
 * Threads that may be active at once. ONE number for everybody — contributing
 * to Ponder unlocks nothing, so there is no tier to vary this by.
 * Mirrors max_active_topics() in the database, which is the real enforcer.
 */
export const MAX_THREADS = 3;

const CACHE_KEY = "ponder.entitlement.v1";
/** How long a cached "yes" is trusted offline before we insist on a refresh. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Thrown when today's entry could not be produced right now — an upstream
 * outage, a rate limit, or a generation failure the pool could not cover.
 *
 * Three rules for the copy, all deliberate:
 *
 *  1. Never worded as a paywall. Nothing the user can buy changes this.
 *  2. Never mentions running costs, credit, or capacity. What Ponder costs to
 *     run is the operator's business, not the reader's.
 *  3. Late, not broken. This is a delay with a retry behind it, and the
 *     wording should leave the user expecting their entry rather than
 *     wondering whether the app has stopped working.
 *
 * Everything already written stays readable throughout.
 */
export class GenerationDelayedError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Today's entry is running late. Everything you've written is still here — try again in a little while.",
    );
    this.name = "GenerationDelayedError";
  }
}

/** Thrown when a free-tier synthesis is refused — too few notes, or too soon. */
export class SynthesisQuotaError extends Error {
  constructor(
    message: string,
    public reason: string,
    public nextAvailableAt: string | null = null,
  ) {
    super(message);
    this.name = "SynthesisQuotaError";
  }
}

let current: EntitlementState = NO_ENTITLEMENT;
let loaded = false;
const listeners = new Set<(s: EntitlementState) => void>();

// ------------------------------------------------------------------ cache

function readCache(): EntitlementState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { state, at } = JSON.parse(raw) as { state: EntitlementState; at: number };
    if (!at || Date.now() - at > CACHE_TTL_MS) return null;
    // Never trust a cached "yes" past its own expiry date.
    if (state.entitled && state.expiresAt && new Date(state.expiresAt) < new Date()) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function writeCache(state: EntitlementState): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* private mode / quota — the cache is best-effort */
  }
}

function publish(state: EntitlementState): void {
  current = state;
  loaded = true;
  writeCache(state);
  for (const fn of listeners) fn(state);
}

// ------------------------------------------------------------------- api

/**
 * Refresh from the store and the server. Call after login, after a purchase,
 * on resume, and whenever a 402 comes back.
 *
 * On failure the previous known state is kept rather than downgraded — a
 * flaky network must not lock a subscriber out of their own journal.
 */
export async function refreshEntitlement(): Promise<EntitlementState> {
  try {
    const next = await readEntitlement();
    publish(next);
    return next;
  } catch (e) {
    console.warn("entitlement refresh failed", e);
    if (!loaded) {
      const cached = readCache();
      if (cached) publish(cached);
    }
    return current;
  }
}

/** Synchronous read of the last known state — for render paths. */
export function entitlement(): EntitlementState {
  if (!loaded) {
    const cached = readCache();
    if (cached) {
      current = cached;
      loaded = true;
    }
  }
  return current;
}

/** Whether the entitlement has been resolved at least once this session. */
export function entitlementLoaded(): boolean {
  return loaded;
}

export function onEntitlementChange(fn: (s: EntitlementState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clear on sign-out / account swap so the next account starts clean. */
export function resetEntitlement(): void {
  loaded = false;
  current = NO_ENTITLEMENT;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ gates

/**
 * Threads this user may run at once. The database is the real enforcer.
 *
 * A function rather than a bare constant so call sites don't have to change
 * if this ever varies again — but it does not vary today, and it must not
 * vary by whether someone has contributed.
 *
 * Note what is NOT in this file any more: shouldShowPaywall(), isSupporter(),
 * isEntitled(). There is no wall and no tier. Support unlocks nothing, so
 * there is nothing for the client to gate on. The RevenueCat entitlement
 * plumbing below still exists and still answers truthfully; nothing reads it.
 */
export function maxActiveThreads(): number {
  return MAX_THREADS;
}

export { billingAvailable };
export type { EntitlementState };
